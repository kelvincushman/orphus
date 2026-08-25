import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	GoalExecutionPlanValidationError,
	initialReadyLeaves,
	normalizeGoalExecutionPlan,
} from "../../packages/workflows/builtin/goal-plan.js";

function validPlan() {
	return {
		version: 1,
		leaves: [
			{
				id: "1.10",
				title: "Second",
				task: "Wire the dependant stage",
				owns: ["packages/workflows/builtin/goal-runner.ts"],
				needs: ["1.2"],
				tier: "standard",
				checks: [{ command: "npm run typecheck", expect: "Typecheck passes" }],
			},
			{
				id: "1.2",
				title: "First",
				task: "Create the contract",
				owns: ["packages/workflows/builtin/goal-plan.ts", "test/unit/goal-plan/**"],
				needs: [],
				tier: "judgment",
				checks: [
					{
						command: "npx vitest --run --project unit test/unit/builtin-workflows-goal-plan.test.ts",
						expect: "Tests pass",
					},
				],
			},
		],
	} as const;
}

function assertInvalid(mutator: (plan: ReturnType<typeof validPlan>) => unknown, message: RegExp): void {
	assert.throws(() => normalizeGoalExecutionPlan(mutator(validPlan())), GoalExecutionPlanValidationError);
	assert.throws(() => normalizeGoalExecutionPlan(mutator(validPlan())), message);
}

describe("GoalExecutionPlan v1", () => {
	test("normalizes valid plans into immutable leaf order and initial readiness", () => {
		const plan = normalizeGoalExecutionPlan(validPlan(), { minLeaves: 2, maxLeaves: 2 });

		assert.deepEqual(
			plan.leaves.map((leaf) => leaf.id),
			["1.2", "1.10"],
		);
		assert.deepEqual(plan.leaves[0].owns, ["packages/workflows/builtin/goal-plan.ts", "test/unit/goal-plan/**"]);
		assert.deepEqual(
			initialReadyLeaves(plan).map((leaf) => leaf.id),
			["1.2"],
		);
		assert.throws(() => {
			(plan.leaves as unknown as { push(leaf: unknown): void }).push(plan.leaves[0]);
		}, TypeError);
		assert.throws(() => {
			(plan.leaves[0] as { task: string }).task = "mutated";
		}, TypeError);
	});

	test("rejects malformed ids", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], id: "leaf-1" }, plan.leaves[1]] }),
			/Invalid leaf id/,
		);
	});

	test("rejects duplicate ids", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], id: "1.2" }, plan.leaves[1]] }),
			/Duplicate leaf id/,
		);
	});

	test("rejects absolute paths", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], owns: ["/tmp/file.ts"] }, plan.leaves[1]] }),
			/absolute path/,
		);
	});

	test("rejects traversal paths", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], owns: ["packages/../file.ts"] }, plan.leaves[1]] }),
			/traversal/,
		);
	});

	test("rejects ambiguous globs outside terminal directory scopes", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], owns: ["packages/**/*.ts"] }, plan.leaves[1]] }),
			/ambiguous glob/,
		);
	});

	test("rejects overlapping exact and directory ownership", () => {
		assertInvalid(
			(plan) => ({
				...plan,
				leaves: [
					{ ...plan.leaves[0], owns: ["packages/workflows/**"] },
					{ ...plan.leaves[1], owns: ["packages/workflows/builtin/goal-plan.ts"] },
				],
			}),
			/Ownership overlap/,
		);
	});

	test("rejects unknown dependencies", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], needs: ["9.9"] }, plan.leaves[1]] }),
			/unknown leaf/,
		);
	});

	test("rejects self dependencies", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], needs: ["1.10"] }, plan.leaves[1]] }),
			/cannot depend on itself/,
		);
	});

	test("rejects dependency cycles", () => {
		assertInvalid(
			(plan) => ({
				...plan,
				leaves: [
					{ ...plan.leaves[0], needs: ["1.2"] },
					{ ...plan.leaves[1], needs: ["1.10"] },
				],
			}),
			/Dependency cycle/,
		);
	});

	test("rejects empty tasks, ownership, and checks", () => {
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], task: " " }, plan.leaves[1]] }),
			/task must not be empty/,
		);
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], owns: [] }, plan.leaves[1]] }),
			/own at least one path/,
		);
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], checks: [] }, plan.leaves[1]] }),
			/declare at least one check/,
		);
	});

	test("rejects invalid check command and expect pairing", () => {
		assertInvalid(
			(plan) => ({
				...plan,
				leaves: [{ ...plan.leaves[0], checks: [{ command: " ", expect: "Tests pass" }] }, plan.leaves[1]],
			}),
			/check command/,
		);
		assertInvalid(
			(plan) => ({ ...plan, leaves: [{ ...plan.leaves[0], checks: [{ command: "npm test" }] }, plan.leaves[1]] }),
			/v1 schema/,
		);
	});

	test("rejects plan sizes outside the provided bounds", () => {
		assert.throws(() => normalizeGoalExecutionPlan(validPlan(), { minLeaves: 3 }), /between 3 and Infinity/);
		assert.throws(() => normalizeGoalExecutionPlan(validPlan(), { maxLeaves: 1 }), /between 1 and 1/);
	});
});
