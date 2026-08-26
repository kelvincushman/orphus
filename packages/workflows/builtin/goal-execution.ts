import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import type { WorkflowTaskOptions, WorkflowTaskResult } from "../src/shared/types.js";
import { goalLeafModelConfig } from "./goal-models.js";
import type { GoalExecutionCheck, GoalExecutionLeaf, GoalExecutionPlan } from "./goal-plan.js";
import { goalExecutionLeafVerificationSchema } from "./goal-schemas.js";
import { taggedPrompt } from "./goal-prompts.js";

type GoalExecutionContext = {
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
};

type LeafStatus = "verified" | "failed" | "blocked";
type CheckStatus = "passed" | "failed" | "blocked";

export type GoalExecutionCheckResult = {
  readonly command: string;
  readonly expect: string;
  readonly status: CheckStatus;
  readonly evidence: string;
};

export type GoalExecutionLeafRecord = {
  readonly leaf_id: string;
  readonly title: string;
  readonly tier: GoalExecutionLeaf["tier"];
  readonly status: LeafStatus;
  readonly task_artifact_path: string;
  readonly verification_artifact_path: string;
  readonly evidence: string;
  readonly remaining_work: string;
  readonly check_results: readonly GoalExecutionCheckResult[];
};

export type GoalExecutionReport = {
  readonly complete: boolean;
  readonly records: readonly GoalExecutionLeafRecord[];
  readonly blocked_leaf_ids: readonly string[];
  readonly failed_leaf_ids: readonly string[];
  readonly report_path: string;
};

export async function runGoalExecutionPlan(input: {
  readonly ctx: GoalExecutionContext;
  readonly plan: GoalExecutionPlan;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly ledgerPath: string;
  readonly artifactDir: string;
  readonly workflowStartCwd: string;
  readonly maxParallelAgents: number;
  readonly turn?: number;
}): Promise<GoalExecutionReport> {
  const records = new Map<string, GoalExecutionLeafRecord>();
  const running = new Map<string, Promise<GoalExecutionLeafRecord>>();
  const dependencyBlockers = new Map<string, string>();
  const leafById = new Map(input.plan.leaves.map((leaf) => [leaf.id, leaf]));
  const turn = normalizeTurn(input.turn);
  const maxParallelAgents = normalizeMaxParallelAgents(input.maxParallelAgents, input.plan.leaves.length);

  const readyLeaves = () =>
    input.plan.leaves.filter((leaf) => {
      if (records.has(leaf.id) || running.has(leaf.id) || dependencyBlockers.has(leaf.id)) return false;
      return leaf.needs.every((need) => records.get(need)?.status === "verified");
    });

  const markBlockedDependants = (leafId: string, cause: string): void => {
    for (const leaf of input.plan.leaves) {
      if (leaf.needs.includes(leafId)) {
        dependencyBlockers.set(leaf.id, cause);
        markBlockedDependants(leaf.id, cause);
      }
    }
  };

  while (records.size + dependencyBlockers.size < input.plan.leaves.length) {
    for (const leaf of readyLeaves()) {
      if (running.size >= maxParallelAgents) break;
      const leafIndex = input.plan.leaves.findIndex((candidate) => candidate.id === leaf.id);
      running.set(leaf.id, runGoalLeaf({ ...input, leaf, leafIndex, turn }));
    }

    if (running.size === 0) {
      for (const leaf of input.plan.leaves) {
        if (!records.has(leaf.id) && !dependencyBlockers.has(leaf.id)) {
          dependencyBlockers.set(leaf.id, `Leaf ${leaf.id} never became ready.`);
        }
      }
      break;
    }

    const completed = await Promise.race(
      [...running.entries()].map(async ([leafId, promise]) => ({ leafId, record: await promise })),
    );
    running.delete(completed.leafId);
    records.set(completed.leafId, completed.record);
    if (completed.record.status !== "verified") {
      markBlockedDependants(
        completed.leafId,
        `Leaf ${completed.leafId} finished with status ${completed.record.status}.`,
      );
    }
  }

  for (const [leafId, cause] of dependencyBlockers) {
    const leaf = leafById.get(leafId);
    if (leaf === undefined || records.has(leafId)) continue;
    const record = await dependencyBlockedRecord(input.artifactDir, leaf, cause, turn);
    records.set(leafId, record);
  }

  const orderedRecords = input.plan.leaves
    .map((leaf) => records.get(leaf.id))
    .filter((record): record is GoalExecutionLeafRecord => record !== undefined);
  const failedLeafIds = orderedRecords.filter((record) => record.status === "failed").map((record) => record.leaf_id);
  const blockedLeafIds = orderedRecords.filter((record) => record.status === "blocked").map((record) => record.leaf_id);
  const reportPath = join(input.artifactDir, `turn-${turn}-goal-execution-report.json`);
  const report: GoalExecutionReport = {
    complete:
      orderedRecords.length === input.plan.leaves.length &&
      orderedRecords.every((record) => record.status === "verified"),
    records: orderedRecords,
    blocked_leaf_ids: blockedLeafIds,
    failed_leaf_ids: failedLeafIds,
    report_path: reportPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  return report;
}

async function runGoalLeaf(input: {
  readonly ctx: GoalExecutionContext;
  readonly plan: GoalExecutionPlan;
  readonly leaf: GoalExecutionLeaf;
  readonly leafIndex: number;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly ledgerPath: string;
  readonly artifactDir: string;
  readonly workflowStartCwd: string;
  readonly turn: number;
}): Promise<GoalExecutionLeafRecord> {
  const taskArtifactPath = join(input.artifactDir, `turn-${input.turn}-leaf-${input.leaf.id}-receipt.md`);
  const verificationArtifactPath = join(
    input.artifactDir,
    `turn-${input.turn}-leaf-${input.leaf.id}-verification.json`,
  );
  const modelConfig = goalLeafModelConfig(input.leaf.tier, input.leafIndex);
  const verifierModelConfig = rotatedVerifierModelConfig(input.leaf.tier, input.leafIndex, modelConfig.model);

  let workResult: WorkflowTaskResult;
  try {
    workResult = await input.ctx.task(`goal-turn-${input.turn}-leaf-${input.leaf.id}`, {
      prompt: renderLeafPrompt(input, taskArtifactPath, verificationArtifactPath),
      reads: [input.ledgerPath],
      output: taskArtifactPath,
      outputMode: "file-only",
      ...modelConfig,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await finalizeLeafRecord(
      {
        leaf_id: input.leaf.id,
        title: input.leaf.title,
        tier: input.leaf.tier,
        status: "failed",
        task_artifact_path: taskArtifactPath,
        verification_artifact_path: verificationArtifactPath,
        evidence: `Leaf task failed before receipt: ${message}`,
        remaining_work: `Rerun or repair leaf ${input.leaf.id}: ${input.leaf.title}`,
        check_results: declaredCheckResults(
          input.leaf.checks,
          "blocked",
          `Leaf task failed before receipt: ${message}`,
        ),
      },
      `Worker stage failed before it could create a receipt.\n\n${message}`,
    );
  }

  try {
    const verification = await input.ctx.task(`goal-turn-${input.turn}-leaf-${input.leaf.id}-verify`, {
      prompt: renderLeafVerificationPrompt(input, taskArtifactPath, verificationArtifactPath),
      reads: [input.ledgerPath, taskArtifactPath],
      output: verificationArtifactPath,
      outputMode: "file-only",
      schema: goalExecutionLeafVerificationSchema,
      ...verifierModelConfig,
    });
    const structured = verification.structured;
    if (Value.Check(goalExecutionLeafVerificationSchema, structured)) {
      const normalized = normalizeVerification(input.leaf, structured);
      if (normalized.status === "failed") {
        return await finalizeLeafRecord(
          {
            leaf_id: input.leaf.id,
            title: input.leaf.title,
            tier: input.leaf.tier,
            status: "failed",
            task_artifact_path: taskArtifactPath,
            verification_artifact_path: verificationArtifactPath,
            evidence: normalized.evidence,
            remaining_work: normalized.remaining_work,
            check_results: normalized.check_results,
          },
          workResult.text,
        );
      }
      return await finalizeLeafRecord(
        {
          leaf_id: input.leaf.id,
          title: input.leaf.title,
          tier: input.leaf.tier,
          status: normalized.status,
          task_artifact_path: taskArtifactPath,
          verification_artifact_path: verificationArtifactPath,
          evidence: normalized.evidence,
          remaining_work: normalized.remaining_work,
          check_results: normalized.check_results,
        },
        workResult.text,
      );
    }
    return await finalizeLeafRecord(
      {
        leaf_id: input.leaf.id,
        title: input.leaf.title,
        tier: input.leaf.tier,
        status: "failed",
        task_artifact_path: taskArtifactPath,
        verification_artifact_path: verificationArtifactPath,
        evidence: workResult.text,
        remaining_work: `Verification for leaf ${input.leaf.id} did not return the required schema.`,
        check_results: declaredCheckResults(
          input.leaf.checks,
          "blocked",
          `Verification for leaf ${input.leaf.id} did not return the required schema.`,
        ),
      },
      workResult.text,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await finalizeLeafRecord(
      {
        leaf_id: input.leaf.id,
        title: input.leaf.title,
        tier: input.leaf.tier,
        status: "failed",
        task_artifact_path: taskArtifactPath,
        verification_artifact_path: verificationArtifactPath,
        evidence: workResult.text,
        remaining_work: `Verification for leaf ${input.leaf.id} failed: ${message}`,
        check_results: declaredCheckResults(
          input.leaf.checks,
          "blocked",
          `Verification for leaf ${input.leaf.id} failed: ${message}`,
        ),
      },
      workResult.text,
    );
  }
}

async function dependencyBlockedRecord(
  artifactDir: string,
  leaf: GoalExecutionLeaf,
  cause: string,
  turn: number,
): Promise<GoalExecutionLeafRecord> {
  return await finalizeLeafRecord(
    {
      leaf_id: leaf.id,
      title: leaf.title,
      tier: leaf.tier,
      status: "blocked",
      task_artifact_path: join(artifactDir, `turn-${turn}-leaf-${leaf.id}-receipt.md`),
      verification_artifact_path: join(artifactDir, `turn-${turn}-leaf-${leaf.id}-verification.json`),
      evidence: `Leaf ${leaf.id} was not dispatched because a dependency path failed closed: ${cause}`,
      remaining_work: `Repair dependencies first: ${leaf.needs.join(", ")}`,
      check_results: declaredCheckResults(
        leaf.checks,
        "blocked",
        `Leaf ${leaf.id} was not dispatched because dependency verification failed.`,
      ),
    },
    `Leaf ${leaf.id} was not dispatched.\n\nDependency failure: ${cause}`,
  );
}

async function finalizeLeafRecord(
  record: GoalExecutionLeafRecord,
  taskArtifactFallback: string,
): Promise<GoalExecutionLeafRecord> {
  if (record.status === "verified") {
    const unavailableArtifacts = await unavailableVerifiedArtifacts([
      record.task_artifact_path,
      record.verification_artifact_path,
    ]);
    if (unavailableArtifacts.length === 0) {
      return record;
    }
    const failedRecord: GoalExecutionLeafRecord = {
      ...record,
      status: "failed",
      evidence: `Verification failed closed because leaf ${record.leaf_id} did not persist non-empty primary evidence artifacts: ${unavailableArtifacts.join(", ")}.`,
      remaining_work: `Rerun leaf ${record.leaf_id} and require both the worker receipt and verifier artifact to be persisted by their stages.`,
    };
    await writeSynthesizedArtifactIfUnavailable(
      failedRecord.task_artifact_path,
      renderSynthesizedTaskArtifact(failedRecord, taskArtifactFallback),
    );
    await writeSynthesizedArtifactIfUnavailable(
      failedRecord.verification_artifact_path,
      `${JSON.stringify({ synthesized: true, record: failedRecord }, null, 2)}\n`,
    );
    return failedRecord;
  }
  await writeSynthesizedArtifactIfUnavailable(
    record.task_artifact_path,
    renderSynthesizedTaskArtifact(record, taskArtifactFallback),
  );
  await writeSynthesizedArtifactIfUnavailable(
    record.verification_artifact_path,
    `${JSON.stringify({ synthesized: true, record }, null, 2)}\n`,
  );
  return record;
}

async function unavailableVerifiedArtifacts(paths: readonly string[]): Promise<string[]> {
  const unavailable: string[] = [];
  for (const path of paths) {
    try {
      const artifact = await stat(path);
      if (!artifact.isFile() || artifact.size === 0 || (await readFile(path, "utf8")).trim().length === 0) {
        unavailable.push(path);
      }
    } catch {
      unavailable.push(path);
    }
  }
  return unavailable;
}

function renderSynthesizedTaskArtifact(record: GoalExecutionLeafRecord, fallback: string): string {
  return [
    `# Goal leaf ${record.leaf_id}: ${record.title}`,
    "",
    `Status: ${record.status}`,
    `Evidence: ${record.evidence}`,
    `Remaining work: ${record.remaining_work}`,
    "",
    "Check results:",
    ...record.check_results.map(
      (check) => `- ${check.status}: ${check.command}\n  EXPECT: ${check.expect}\n  EVIDENCE: ${check.evidence}`,
    ),
    "",
    "Stage output:",
    fallback,
    "",
  ].join("\n");
}

async function writeSynthesizedArtifactIfUnavailable(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const artifact = await stat(path);
    if (artifact.isFile() && artifact.size > 0 && (await readFile(path, "utf8")).trim().length > 0) {
      return;
    }
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
  }
  await writeFile(path, contents, { encoding: "utf8" });
}

function normalizeTurn(turn: number | undefined): number {
  if (turn === undefined) {
    return 1;
  }
  if (!Number.isInteger(turn) || turn < 1) {
    throw new Error("Goal execution turn must be a positive integer.");
  }
  return turn;
}

function normalizeMaxParallelAgents(value: number, leafCount: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error("Goal execution maxParallelAgents must be a positive finite integer.");
  }
  return Math.min(value, leafCount);
}

function normalizeVerification(
  leaf: GoalExecutionLeaf,
  structured: {
    readonly status: LeafStatus;
    readonly evidence: string;
    readonly remaining_work: string;
    readonly checks: readonly GoalExecutionCheckResult[];
  },
): Pick<GoalExecutionLeafRecord, "status" | "evidence" | "remaining_work" | "check_results"> {
  const evidence = structured.evidence.trim();
  const remainingWork = structured.remaining_work.trim();
  const checkResults = structured.checks.map((check) => ({
    command: check.command.trim(),
    expect: check.expect.trim(),
    status: check.status,
    evidence: check.evidence.trim(),
  }));
  const checkFailure = validateCheckResults(leaf, checkResults);
  if (evidence.length === 0) {
    return {
      status: "failed",
      evidence: "Verification failed closed because it returned empty evidence.",
      remaining_work: "Rerun verification with concrete evidence for the declared leaf checks.",
      check_results: checkResults,
    };
  }
  if (checkFailure !== undefined) {
    return {
      status: "failed",
      evidence: checkFailure,
      remaining_work: "Rerun verification against the exact declared checks for this leaf.",
      check_results: checkResults,
    };
  }
  if (structured.status === "verified" && remainingWork !== "none") {
    return {
      status: "failed",
      evidence: `Verification contradicted itself: status=verified but remaining_work=${JSON.stringify(remainingWork)}.`,
      remaining_work:
        remainingWork.length === 0 ? "Rerun verification with an explicit remaining_work value." : remainingWork,
      check_results: checkResults,
    };
  }
  if (structured.status === "verified" && checkResults.some((check) => check.status !== "passed")) {
    return {
      status: "failed",
      evidence: "Verification contradicted itself: status=verified but one or more declared checks did not pass.",
      remaining_work: "Repair or rerun every non-passing declared check.",
      check_results: checkResults,
    };
  }
  if (structured.status !== "verified" && remainingWork.length === 0) {
    return {
      status: "failed",
      evidence: "Verification failed closed because a failed or blocked result returned empty remaining_work.",
      remaining_work: "Rerun verification with explicit remaining work.",
      check_results: checkResults,
    };
  }
  return {
    status: structured.status,
    evidence,
    remaining_work: remainingWork,
    check_results: checkResults,
  };
}

function validateCheckResults(
  leaf: GoalExecutionLeaf,
  checkResults: readonly GoalExecutionCheckResult[],
): string | undefined {
  if (checkResults.length !== leaf.checks.length) {
    return `Verification returned ${checkResults.length} check results for ${leaf.checks.length} declared checks.`;
  }

  const seen = new Set<string>();
  for (let index = 0; index < checkResults.length; index += 1) {
    const expected = leaf.checks[index];
    const actual = checkResults[index];
    const key = `${actual.command}\n${actual.expect}`;
    if (seen.has(key)) {
      return `Verification duplicated check result ${JSON.stringify(actual.command)}.`;
    }
    seen.add(key);
    if (actual.command !== expected.command || actual.expect !== expected.expect) {
      return `Verification check ${index + 1} did not match the frozen command/expect pair.`;
    }
    if (actual.evidence.length === 0) {
      return `Verification check ${index + 1} returned empty evidence.`;
    }
  }

  return undefined;
}

function declaredCheckResults(
  checks: readonly GoalExecutionCheck[],
  status: CheckStatus,
  evidence: string,
): readonly GoalExecutionCheckResult[] {
  return checks.map((check) => ({
    command: check.command,
    expect: check.expect,
    status,
    evidence,
  }));
}

function rotatedVerifierModelConfig(tier: GoalExecutionLeaf["tier"], workerIndex: number, workerModel: string) {
  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = goalLeafModelConfig(tier, workerIndex + offset);
    if (candidate.model !== workerModel) {
      return candidate;
    }
  }
  return goalLeafModelConfig(tier, workerIndex + 1);
}

function renderLeafPrompt(
  input: {
    readonly plan: GoalExecutionPlan;
    readonly leaf: GoalExecutionLeaf;
    readonly objective: string;
    readonly acceptanceCriteria: string;
    readonly ledgerPath: string;
    readonly workflowStartCwd: string;
  },
  taskArtifactPath: string,
  verificationArtifactPath: string,
): string {
  return taggedPrompt([
    [
      "context",
      [
        `Current working directory: ${input.workflowStartCwd}`,
        `Goal ledger artifact: ${input.ledgerPath}`,
        `Receipt artifact path: ${taskArtifactPath}`,
        `Verification artifact path: ${verificationArtifactPath}`,
      ].join("\n"),
    ],
    ["objective", input.objective],
    ["acceptance_criteria", input.acceptanceCriteria],
    ["leaf_contract", renderLeafContract(input.leaf)],
    [
      "method",
      [
        "You own only this leaf. Do not edit files outside owns unless the task is impossible without reporting the conflict.",
        "Implement the smallest correct change for this leaf, run or document the declared checks, and return an evidence-bearing receipt.",
        "You are part of a larger rolling team. Do not rewrite the global plan, wait for unrelated leaves, or claim the full goal complete.",
      ].join("\n"),
    ],
  ]);
}

function renderLeafVerificationPrompt(
  input: {
    readonly leaf: GoalExecutionLeaf;
    readonly objective: string;
    readonly acceptanceCriteria: string;
    readonly workflowStartCwd: string;
    readonly ledgerPath: string;
  },
  taskArtifactPath: string,
  verificationArtifactPath: string,
): string {
  return taggedPrompt([
    [
      "context",
      [
        `Current working directory: ${input.workflowStartCwd}`,
        `Goal ledger artifact: ${input.ledgerPath}`,
        `Leaf receipt artifact: ${taskArtifactPath}`,
        `Verification artifact path: ${verificationArtifactPath}`,
      ].join("\n"),
    ],
    ["objective", input.objective],
    ["acceptance_criteria", input.acceptanceCriteria],
    ["leaf_contract", renderLeafContract(input.leaf)],
    [
      "verification",
      [
        "Independently verify this leaf only. Do not trust the worker receipt.",
        "Inspect that edits stayed within the owned-file boundary before accepting the leaf.",
        "Actually run every safe declared check for this leaf; report any unsafe or unavailable check as remaining work.",
        "Return one checks[] entry for every declared check, in the same order, with the exact command, exact expect, status passed|failed|blocked, and non-empty evidence.",
        "Set status=verified only when the owned files and every declared check are evidenced for this leaf.",
        "Set status=failed for ordinary missing or broken implementation. Set status=blocked only for a true external or dependency impasse.",
        "remaining_work must be 'none' only when status=verified.",
      ].join("\n"),
    ],
  ]);
}

function renderLeafContract(leaf: GoalExecutionLeaf): string {
  return [
    `Leaf: ${leaf.id} ${leaf.title}`,
    `Tier: ${leaf.tier}`,
    `Needs: ${leaf.needs.length === 0 ? "none" : leaf.needs.join(", ")}`,
    "Owns:",
    ...leaf.owns.map((path) => `- ${path}`),
    "Task:",
    leaf.task,
    "Checks:",
    ...leaf.checks.map((check) => `- CHECK: ${check.command}\n  EXPECT: ${check.expect}`),
  ].join("\n");
}
