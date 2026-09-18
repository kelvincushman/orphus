import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer, Questions, State, SystemOne, SystemOneReceipt } from "@orphus/systemone";
import { answerFrom, uncertainAnswers } from "@orphus/systemone";
import { afterEach, beforeEach, describe, test } from "vitest";
import { normalizeGoalExecutionPlan, withTierOverrides } from "../../packages/workflows/builtin/goal-plan.js";
import {
	applySystemOneTiers,
	createGoalSystemOne,
	leafTierState,
	reasoningRequiredQuestion,
	systemOneReceiptPath,
	TIER_LEVELS,
} from "../../packages/workflows/builtin/goal-systemone.js";
import { setSystemOneConfig, withSystemOneDefaults } from "../../packages/workflows/src/shared/systemone-config.js";

const noEnv = () => undefined;

/**
 * An adapter that answers every score question with the level it is told,
 * or abstains when told nothing. Stands in for a real model so the receipt
 * and override paths are exercised for real.
 */
function stubAdapter(level: number | undefined): SystemOne {
	return {
		id: "stub@1",
		decide: async (_state: State, questions: Questions) => {
			if (level === undefined) return uncertainAnswers(questions);
			const answers: Record<string, Answer> = {};
			for (const [name, question] of Object.entries(questions)) {
				answers[name] =
					question.type === "score"
						? answerFrom(
								question,
								Object.fromEntries(
									question.criteria.map((_c, index) => [String(index), index === level ? 1 : 0]),
								),
							)
						: uncertainAnswers({ [name]: question })[name]!;
			}
			return answers;
		},
	};
}

/** An adapter that always fails, standing in for an unreachable model server. */
const brokenAdapter: SystemOne = {
	id: "broken@1",
	decide: async () => {
		throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
	},
};

function plan(tiers: readonly string[]) {
	return normalizeGoalExecutionPlan({
		version: 1,
		leaves: tiers.map((tier, index) => ({
			id: String(index + 1),
			title: `Leaf ${index + 1}`,
			task: `Do work ${index + 1}`,
			owns: [`packages/leaf-${index + 1}.ts`],
			needs: [],
			tier,
			checks: [{ command: "npm run check", expect: "passes" }],
		})),
	});
}

async function readReceipts(path: string): Promise<SystemOneReceipt[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SystemOneReceipt);
}

describe("Goal tier decisions", () => {
	let artifactDir: string;
	let planArtifactPath: string;

	beforeEach(async () => {
		artifactDir = await mkdtemp(join(tmpdir(), "orphus-goal-systemone-"));
		planArtifactPath = join(artifactDir, "plan.json");
		setSystemOneConfig(withSystemOneDefaults({}, noEnv));
	});

	afterEach(async () => {
		setSystemOneConfig(withSystemOneDefaults({}, noEnv));
		await rm(artifactDir, { recursive: true, force: true });
	});

	test("the default adapter changes nothing and writes no receipts", async () => {
		// The acceptance test for the wiring: under `null`, the plan the workers
		// receive is the identical frozen object the planner produced.
		const { systemOne } = createGoalSystemOne({ artifactDir, turn: 1 });
		const original = plan(["standard", "standard"]);
		const result = await applySystemOneTiers({ systemOne, plan: original, planArtifactPath });

		assert.equal(result, original);
		assert.equal(systemOne.enabled, false);
		await assert.rejects(() => readFile(systemOneReceiptPath(artifactDir, 1), "utf8"));
	});

	test("a confident answer re-tiers the leaf and persists the plan that will run", async () => {
		const { systemOne } = createGoalSystemOne({ artifactDir, turn: 1, adapter: stubAdapter(0) });
		const result = await applySystemOneTiers({ systemOne, plan: plan(["judgment", "standard"]), planArtifactPath });

		assert.equal(systemOne.enabled, true);
		assert.deepEqual(
			result.leaves.map((leaf) => leaf.tier),
			["fast", "fast"],
		);
		// The artifact is what the run is audited against, so it must not still
		// claim the tiers the planner guessed.
		const persisted = JSON.parse(await readFile(planArtifactPath, "utf8")) as { leaves: { tier: string }[] };
		assert.deepEqual(
			persisted.leaves.map((leaf) => leaf.tier),
			["fast", "fast"],
		);
	});

	test("an unsure answer leaves the planner's tier standing", async () => {
		const { systemOne } = createGoalSystemOne({ artifactDir, turn: 1, adapter: stubAdapter(undefined) });
		const result = await applySystemOneTiers({ systemOne, plan: plan(["judgment", "fast"]), planArtifactPath });

		assert.deepEqual(
			result.leaves.map((leaf) => leaf.tier),
			["judgment", "fast"],
		);
		await assert.rejects(() => readFile(planArtifactPath, "utf8"), "an unchanged plan must not be rewritten");
	});

	test("an adapter that throws abstains rather than failing the run", async () => {
		// An unreachable model server must cost latency, never the plan.
		const { systemOne } = createGoalSystemOne({ artifactDir, turn: 1, adapter: brokenAdapter });
		const original = plan(["standard"]);
		const result = await applySystemOneTiers({ systemOne, plan: original, planArtifactPath });

		assert.deepEqual(
			result.leaves.map((leaf) => leaf.tier),
			["standard"],
		);
		const receipts = await readReceipts(systemOneReceiptPath(artifactDir, 1));
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0]!.abstain, true, "a failed call must be recorded as an abstention, not omitted");
	});

	test("records a receipt per leaf, naming the planner's guess it was checking", async () => {
		const { systemOne } = createGoalSystemOne({ artifactDir, turn: 1, adapter: stubAdapter(2) });
		await applySystemOneTiers({ systemOne, plan: plan(["fast", "standard"]), planArtifactPath });

		// Leaves are asked concurrently, so the file's order follows completion,
		// not plan order. Sort by the leaf each receipt names.
		const receipts = (await readReceipts(systemOneReceiptPath(artifactDir, 1))).sort((left, right) =>
			(left.context?.leaf_id ?? "").localeCompare(right.context?.leaf_id ?? ""),
		);
		assert.equal(receipts.length, 2);
		for (const receipt of receipts) {
			assert.equal(receipt.surface, "goal.tier");
			assert.equal(receipt.question_key, "reasoning_required");
			assert.equal(receipt.kind, "score");
			assert.equal(receipt.calibrated, false, "no adapter is calibrated yet and receipts must say so");
			assert.equal(receipt.adapter_id, "stub@1");
			assert.equal(receipt.threshold, 0.8);
			assert.match(receipt.state_hash, /^[0-9a-f]{32}$/u);
			assert.ok(receipt.context?.leaf_id, "a receipt must name the leaf it judged");
		}
		assert.deepEqual(
			receipts.map((receipt) => receipt.context?.planner_tier),
			["fast", "standard"],
			"a receipt must record the guess it was checking, so an override is never silent",
		);
	});

	test("a raised threshold turns a previously acted-on answer into an abstention", async () => {
		// The threshold is the user's dial for how far to trust the layer; at 1
		// nothing short of certainty acts, which is how a surface is disabled.
		setSystemOneConfig(withSystemOneDefaults({ thresholds: { tier: 1 } }, noEnv));
		const { systemOne } = createGoalSystemOne({ artifactDir, turn: 1, adapter: stubAdapter(0) });
		const result = await applySystemOneTiers({ systemOne, plan: plan(["judgment"]), planArtifactPath });

		assert.equal(result.leaves[0]!.tier, "fast", "a certain answer still acts at threshold 1");
		setSystemOneConfig(withSystemOneDefaults({ thresholds: { tier: 0.4 } }, noEnv));
		assert.equal(createGoalSystemOne({ artifactDir, turn: 1 }).systemOne.thresholds.tier, 0.4);
	});

	test("the rubric has exactly one level per dispatchable tier", () => {
		// A rubric level with no tier to map to would pick the wrong model pool.
		assert.equal(reasoningRequiredQuestion().criteria.length, TIER_LEVELS.length);
		assert.deepEqual([...TIER_LEVELS], ["fast", "standard", "judgment"]);
	});

	test("the tier state carries the contract, not the planner's own verdict", () => {
		// Feeding the planner's tier into the state would let the layer agree
		// with the guess it exists to check.
		const state = leafTierState(plan(["judgment"]).leaves[0]!) as Record<string, unknown>;
		assert.deepEqual(Object.keys(state).sort(), ["checks", "depends_on", "owns", "task", "title"]);
		assert.equal(JSON.stringify(state).includes("judgment"), false);
	});
});

describe("tier overrides on a frozen plan", () => {
	test("produce a new frozen plan rather than mutating the one dispatched against", () => {
		const original = plan(["standard", "judgment"]);
		const result = withTierOverrides(original, new Map([["1", "fast"]]));

		assert.notEqual(result, original);
		assert.equal(original.leaves[0]!.tier, "standard", "the original plan must be untouched");
		assert.equal(result.leaves[0]!.tier, "fast");
		assert.equal(result.leaves[1]!.tier, "judgment");
		assert.throws(() => {
			(result.leaves[0] as { tier: string }).tier = "judgment";
		}, TypeError);
	});

	test("return the same plan when nothing changes, so no artifact rewrite is triggered", () => {
		const original = plan(["standard"]);
		assert.equal(withTierOverrides(original, new Map()), original);
		assert.equal(withTierOverrides(original, new Map([["1", "standard"]])).leaves[0]!.tier, "standard");
	});

	test("ignore an override for a leaf the plan does not contain", () => {
		const original = plan(["standard"]);
		const result = withTierOverrides(original, new Map([["9", "fast"]]));
		assert.deepEqual(
			result.leaves.map((leaf) => leaf.tier),
			["standard"],
		);
	});
});
