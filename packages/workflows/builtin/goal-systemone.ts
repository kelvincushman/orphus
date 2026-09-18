/**
 * Goal's use of the System One layer.
 *
 * Every consultation here happens BEFORE the model step it could save, on
 * state that already exists, and never re-judges a step the model has already
 * finished. That ordering is the difference between a triage layer and an
 * override layer, and only the first one can be added to a working loop
 * without making it less trustworthy.
 *
 * Nothing in this file decides anything by itself: an abstention leaves the
 * caller on exactly the path it was on, which is why the default adapter
 * abstaining on everything is a true no-op.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertValidQuestions,
  type CompleteStructured,
  confidentScoreLevel,
  createSystemOne,
  type Decision,
  nullSystemOne,
  decisionOf,
  type Questions,
  receiptOf,
  type ScoreQuestion,
  type State,
  type SystemOne,
  type SystemOneReceipt,
  stateHash,
  uncertainAnswers,
} from "@orphus/systemone";
import { getEnvValue } from "@orphus/coding-agent";
import type { WorkflowTaskOptions, WorkflowTaskResult } from "../src/shared/types.js";
import { ENV_TYPESAFE_API_KEY, resolveSystemOneConfig } from "../src/shared/systemone-config.js";
import { goalLeafModelConfig } from "./goal-models.js";
import {
  type GoalExecutionLeaf,
  type GoalExecutionPlan,
  type GoalExecutionTier,
  withTierOverrides,
} from "./goal-plan.js";

/** Where a turn's receipts land, beside the evidence they influenced. */
export function systemOneReceiptPath(artifactDir: string, turn: number): string {
  return join(artifactDir, `turn-${turn}-systemone-receipts.jsonl`);
}

/** The one thing the layer needs from Goal to run a model-backed adapter. */
type GoalTaskRunner = {
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
};

/**
 * Run one constrained completion as a workflow stage.
 *
 * Deliberately on the `fast` tier's own model: a decision meant to be cheaper
 * than the step it replaces must not be routed to a more expensive model than
 * that step would have used. The stage reads no files and writes no artifact —
 * its whole input is the prompt, and its whole output is the structured answer.
 */
function stageCompletion(ctx: GoalTaskRunner, turn: number): CompleteStructured {
  let call = 0;
  return async ({ prompt, schema }) => {
    call += 1;
    const result = await ctx.task(`systemone-turn-${turn}-${call}`, {
      prompt,
      schema,
      reads: false,
      output: false,
      ...goalLeafModelConfig("fast", 0),
    });
    return result.structured;
  };
}

export interface GoalSystemOneAsk {
  /** Names the call site in the receipt, e.g. "goal.tier". */
  readonly surface: string;
  readonly state: State;
  readonly questions: Questions;
  readonly threshold: number;
  readonly context?: Readonly<Record<string, string>>;
}

export interface GoalSystemOne {
  readonly adapterId: string;
  readonly thresholds: { readonly tier: number; readonly review: number; readonly verify: number };
  /** True when this adapter is doing real work, so a caller can skip assembling state. */
  readonly enabled: boolean;
  ask(input: GoalSystemOneAsk): Promise<Record<string, Decision>>;
}

/**
 * Build the layer for one Goal run.
 *
 * A failure to construct the adapter is deliberately not fatal: a stale or
 * mistaken `systemOne` setting should cost the user this layer, not their run.
 * The reason is returned so the caller can surface it once rather than
 * swallowing it.
 */
export function createGoalSystemOne(input: {
  readonly artifactDir: string;
  readonly turn: number;
  /** Lets a model-backed adapter run a stage. Omit it and only `null` can be built. */
  readonly ctx?: GoalTaskRunner;
  /** Supplied instead of building one from config; the seam tests decide through. */
  readonly adapter?: SystemOne;
  readonly now?: () => Date;
}): { readonly systemOne: GoalSystemOne; readonly warning?: string } {
  const config = resolveSystemOneConfig();
  let adapter: SystemOne;
  let warning: string | undefined;
  if (input.adapter !== undefined) {
    adapter = input.adapter;
  } else {
    try {
      adapter = createSystemOne({
        adapter: config.adapter,
        local: config.local,
        // Read here and nowhere else: a hosted credential does not belong in a
        // config file that gets committed.
        typesafe: { ...config.typesafe, apiKey: getEnvValue(ENV_TYPESAFE_API_KEY) ?? "" },
        ...(input.ctx === undefined ? {} : { complete: stageCompletion(input.ctx, input.turn) }),
      });
    } catch (err) {
      warning = `System One disabled: ${err instanceof Error ? err.message : String(err)}`;
      adapter = createSystemOne({ adapter: "null" });
    }
  }

  const receiptPath = systemOneReceiptPath(input.artifactDir, input.turn);
  // Leaves are asked concurrently, so appends are chained: two records must not
  // interleave inside one line, and each batch lands whole. Failures are
  // swallowed here — receipts are evidence, and losing the evidence must not
  // fail the run that was producing it.
  let appends: Promise<void> = Promise.resolve();
  const appendReceipts = (lines: string): Promise<void> => {
    appends = appends.then(async () => {
      try {
        await mkdir(dirname(receiptPath), { recursive: true });
        await appendFile(receiptPath, lines, "utf8");
      } catch {
        // Intentionally ignored; the decisions the lines describe still stand.
      }
    });
    return appends;
  };
  // Whether the layer is doing real work is a property of the adapter that was
  // built, not of the name that was requested — so a construction failure that
  // fell back to `null` correctly reports itself as disabled.
  const enabled = adapter.id !== nullSystemOne.id;

  const ask = async (request: GoalSystemOneAsk): Promise<Record<string, Decision>> => {
    assertValidQuestions(request.questions);
    // An adapter that cannot answer must cost latency, never correctness: an
    // unreachable model server or a malformed response abstains, and the
    // caller stays on the path it would have taken with no layer at all.
    let answers: Awaited<ReturnType<SystemOne["decide"]>>;
    try {
      answers = await adapter.decide(request.state, request.questions);
    } catch {
      answers = uncertainAnswers(request.questions);
    }

    const hash = stateHash(request.state);
    const decisions: Record<string, Decision> = {};
    const receipts: SystemOneReceipt[] = [];
    for (const [key, question] of Object.entries(request.questions)) {
      const answer = answers[key];
      const decision =
        answer === undefined
          ? decisionOf(uncertainAnswers({ [key]: question })[key]!, request.threshold)
          : decisionOf(answer, request.threshold);
      decisions[key] = decision;
      receipts.push(
        receiptOf({
          surface: request.surface,
          questionKey: key,
          question,
          decision,
          threshold: request.threshold,
          adapterId: adapter.id,
          // No adapter is calibrated yet. When one is, it reports so itself
          // rather than this call site assuming it.
          calibrated: false,
          stateHash: hash,
          ...(request.context === undefined ? {} : { context: request.context }),
          ...(input.now === undefined ? {} : { now: input.now }),
        }),
      );
    }

    await appendReceipts(`${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`);
    return decisions;
  };

  return {
    systemOne: { adapterId: adapter.id, thresholds: config.thresholds, enabled, ask },
    ...(warning === undefined ? {} : { warning }),
  };
}

/** The tiers a Goal leaf can be dispatched at, in the order the rubric scores them. */
export const TIER_LEVELS = ["fast", "standard", "judgment"] as const;

/**
 * "How much reasoning is required?" — the model-router question, asked of a
 * leaf before any worker is dispatched for it.
 *
 * The rubric text is the planner's own tier guidance, so a confident answer
 * and the planner's guess are answering the same question rather than two
 * subtly different ones.
 */
export function reasoningRequiredQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions:
      "How much reasoning does implementing and verifying this leaf require? Judge the work itself, not how important it is.",
    criteria: [
      "Mechanical or local: a rename, a moved file, a config value, a doc edit, a change whose shape is fully determined by the task text.",
      "Ordinary implementation: normal feature or fix work in existing code, following patterns already present.",
      "Architecture, security, or risky integration: new structure, a trust boundary, concurrency, a migration, or anything whose failure mode is hard to see in review.",
    ],
  };
}

/** The leaf contract as the state for a tier decision: what the leaf is, not what it is called. */
export function leafTierState(leaf: GoalExecutionLeaf): State {
  return {
    title: leaf.title,
    task: leaf.task,
    owns: [...leaf.owns],
    depends_on: [...leaf.needs],
    checks: leaf.checks.map((check) => ({ command: check.command, expect: check.expect })),
  };
}

/**
 * Re-tier the frozen plan wherever the layer is confident, then persist it.
 *
 * Leaves are asked concurrently: they are independent questions about
 * independent contracts, and asking them in sequence would put the whole
 * plan's latency in front of the first worker.
 *
 * The rewritten artifact is the one the run is audited against, so a reader
 * comparing the plan to the dispatch sees the tiers that actually ran. The
 * receipts alongside it carry the planner's guess, the answer, and its
 * confidence, so the override is never silent.
 */
export async function applySystemOneTiers(input: {
  readonly systemOne: GoalSystemOne;
  readonly plan: GoalExecutionPlan;
  readonly planArtifactPath: string;
}): Promise<GoalExecutionPlan> {
  if (!input.systemOne.enabled) {
    return input.plan;
  }

  const question = reasoningRequiredQuestion();
  const decided = await Promise.all(
    input.plan.leaves.map(async (leaf) => {
      const decisions = await input.systemOne.ask({
        surface: "goal.tier",
        state: leafTierState(leaf),
        questions: { reasoning_required: question },
        threshold: input.systemOne.thresholds.tier,
        context: { leaf_id: leaf.id, planner_tier: leaf.tier },
      });
      const level = confidentScoreLevel(decisions.reasoning_required);
      return { id: leaf.id, tier: level === undefined ? undefined : TIER_LEVELS[level] };
    }),
  );

  const overrides = new Map<string, GoalExecutionTier>();
  for (const { id, tier } of decided) {
    if (tier !== undefined) overrides.set(id, tier);
  }
  const plan = withTierOverrides(input.plan, overrides);
  if (plan !== input.plan) {
    await writeFile(input.planArtifactPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8" });
  }
  return plan;
}
