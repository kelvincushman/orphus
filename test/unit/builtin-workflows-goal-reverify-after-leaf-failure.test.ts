import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "vitest";
import type {
	WorkflowDefinition,
	WorkflowTaskOptions,
	WorkflowTaskResult,
	WorkflowTaskStep,
} from "../../packages/workflows/src/shared/types.js";
import { normalizePathSeparators, readPaths } from "./builtin-workflows-helpers.js";

type TaskCall = {
	readonly name: string;
	readonly options: WorkflowTaskOptions;
};

function result(
	name: string,
	options: WorkflowTaskOptions,
	structured?: WorkflowTaskResult["structured"],
): WorkflowTaskResult {
	const text = structured === undefined ? `${name} receipt` : JSON.stringify(structured);
	if (typeof options.output === "string" && !existsSync(options.output)) {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, text, "utf8");
	}
	return {
		name,
		stageName: name,
		text,
		...(structured === undefined ? {} : { structured }),
		...(typeof options.output === "string" ? { sessionFile: `${options.output}.jsonl` } : {}),
	};
}

const turnOnePlan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "Leaf that passes first",
			task: "Complete first leaf",
			owns: ["packages/one.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "npm run check:one", expect: "one ok" }],
		},
		{
			id: "2",
			title: "Leaf that fails first",
			task: "Complete second leaf",
			owns: ["packages/two.ts"],
			needs: [],
			tier: "fast",
			checks: [{ command: "npm run check:two", expect: "two ok" }],
		},
		{
			id: "3",
			title: "Blocked dependant",
			task: "Depends on the failed leaf",
			owns: ["packages/three.ts"],
			needs: ["2"],
			tier: "judgment",
			checks: [{ command: "npm run check:three", expect: "three ok" }],
		},
	],
} as const;

const partialRepairPlan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "Repair failed leaf",
			task: "Repair second leaf",
			owns: ["packages/two.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "npm run check:two", expect: "two ok" }],
		},
		{
			id: "2",
			title: "Repair dependant",
			task: "Repair dependent integration",
			owns: ["packages/three.ts"],
			needs: ["1"],
			tier: "judgment",
			checks: [{ command: "npm run check:three", expect: "three ok" }],
		},
		{
			id: "3",
			title: "Repair docs",
			task: "Close repair evidence",
			owns: ["docs/repair.md"],
			needs: ["2"],
			tier: "fast",
			checks: [{ command: "npm run check:docs", expect: "docs ok" }],
		},
	],
} as const;

const successfulRepairPlan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "Repair failed leaf",
			task: "Repair second leaf",
			owns: ["packages/two-repaired.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "npm run check:two-repaired", expect: "two repaired ok" }],
		},
		{
			id: "2",
			title: "Prove repaired dependant",
			task: "Prove downstream integration",
			owns: ["packages/three-repaired.ts"],
			needs: ["1"],
			tier: "judgment",
			checks: [{ command: "npm run check:three-repaired", expect: "three repaired ok" }],
		},
		{
			id: "3",
			title: "Close repair proof",
			task: "Close exact repair evidence",
			owns: ["docs/repair-proof.md"],
			needs: ["2"],
			tier: "fast",
			checks: [{ command: "npm run check:repair-proof", expect: "repair proof ok" }],
		},
	],
} as const;

function verificationFor(
	plan: typeof turnOnePlan | typeof partialRepairPlan | typeof successfulRepairPlan,
	leafId: string,
	status: "verified" | "failed" = "verified",
) {
	const leaf = plan.leaves.find((candidate) => candidate.id === leafId);
	assert.ok(leaf, `unknown leaf ${leafId}`);
	return {
		status,
		evidence:
			status === "verified" ? `leaf ${leafId} exact current checks passed` : `leaf ${leafId} failed current checks`,
		remaining_work: status === "verified" ? "none" : `repair leaf ${leafId}`,
		checks: leaf.checks.map((check) => ({
			command: check.command,
			expect: check.expect,
			status: status === "verified" ? ("passed" as const) : ("failed" as const),
			evidence: `${check.command} observed ${check.expect}`,
		})),
	};
}

function reviewDecision() {
	return {
		findings: [],
		overall_correctness: "patch is correct",
		overall_explanation: "repair plan and every verification artifact prove the outcome",
		overall_confidence_score: 0.9,
		goal_oracle_satisfied: true,
		requirements_traceability: [
			{
				requirement: "repair failed leaf before completion",
				status: "proven",
				evidence: "turn 2 verification artifacts passed exact checks",
			},
		],
		receipt_assessment: "current artifacts corroborate completion",
		verification_remaining: "none",
		stop_review_loop: true,
		reviewer_error: null,
	};
}

function workflowInputs(maxTurns: number) {
	return {
		objective: "Reverify and repair a failed Goal leaf",
		min_team_size: 3,
		max_team_size: 24,
		max_parallel_agents: 3,
		max_turns: maxTurns,
		base_branch: "origin/main",
		git_worktree_dir: "",
		create_pr: false,
	};
}

async function importGoalWorkflow(): Promise<WorkflowDefinition> {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	return mod.default as unknown as WorkflowDefinition;
}

type RepairPlan = typeof partialRepairPlan | typeof successfulRepairPlan;

function makeCtx(maxTurns: number, calls: TaskCall[], secondTurnPlan: RepairPlan = successfulRepairPlan) {
	return {
		inputs: workflowInputs(maxTurns),
		runId: crypto.randomUUID(),
		cwd: process.cwd(),
		task: async (name: string, options: WorkflowTaskOptions) => {
			calls.push({ name, options });
			if (name === "planner-1") return result(name, options, turnOnePlan);
			if (name === "planner-2") {
				const reads = readPaths(options).map(normalizePathSeparators);
				assert.ok(
					reads.some((path) => /goal-execution-plan-turn-1\.json$/.test(path)),
					"planner-2 reads turn-1 plan",
				);
				assert.ok(
					reads.some((path) => /turn-1-goal-execution-report\.json$/.test(path)),
					"planner-2 reads turn-1 report",
				);
				for (const leafId of ["1", "2", "3"]) {
					assert.ok(
						reads.some((path) => new RegExp(`turn-1-leaf-${leafId}-verification\\.json$`).test(path)),
						`planner-2 reads turn-1 leaf ${leafId} verification`,
					);
				}
				return result(name, options, secondTurnPlan);
			}
			if (name === "goal-turn-1-leaf-2-verify") {
				return result(name, options, verificationFor(turnOnePlan, "2", "failed"));
			}
			if (name.startsWith("goal-turn-1-") && name.endsWith("-verify")) {
				return result(name, options, verificationFor(turnOnePlan, name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
			}
			if (name.startsWith("goal-turn-2-") && name.endsWith("-verify")) {
				return result(name, options, verificationFor(secondTurnPlan, name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
			}
			return result(name, options);
		},
		parallel: async (steps: readonly WorkflowTaskStep[]) =>
			steps.map((step) => {
				calls.push({ name: step.name, options: step });
				return result(step.name, step, reviewDecision());
			}),
		chain: async () => [],
		workflow: async () => {
			throw new Error("child workflows are not used by Goal");
		},
		stage: () => {
			throw new Error("stages are not used by Goal");
		},
		tool: async () => {
			throw new Error("tools are not used by Goal");
		},
		ui: {},
		exit: () => {
			throw new Error("exit is not used by Goal");
		},
	};
}

test("failed leaf evidence feeds planner turn 2 and completion waits for an independently verified repair plan", async () => {
	const workflow = await importGoalWorkflow();
	const calls: TaskCall[] = [];
	const outcome = await workflow.run(makeCtx(2, calls) as never);

	assert.equal(outcome.status, "complete");
	assert.equal(
		calls.some((call) => call.name === "completion-reviewer-1"),
		false,
	);
	assert.equal(
		calls.some((call) => call.name === "completion-reviewer-2"),
		true,
	);
	assert.equal(existsSync(outcome.execution_plan_path as string), true);
	assert.equal(existsSync(outcome.execution_report_path as string), true);

	const turnTwoPlan = JSON.parse(readFileSync(outcome.execution_plan_path as string, "utf8"));
	assert.equal(turnTwoPlan.leaves[0].checks[0].command, "npm run check:two-repaired");
	const report = JSON.parse(readFileSync(outcome.execution_report_path as string, "utf8"));
	assert.equal(report.complete, true);
	assert.deepEqual(report.failed_leaf_ids, []);
	assert.deepEqual(report.blocked_leaf_ids, []);
	for (const record of report.records) {
		assert.equal(record.status, "verified");
		assert.equal(
			record.check_results.every((check: { status: string }) => check.status === "passed"),
			true,
		);
		assert.equal(existsSync(record.verification_artifact_path), true);
	}
});

test("max-turn failed execution preserves artifacts and runs no final reviewers", async () => {
	const workflow = await importGoalWorkflow();
	const calls: TaskCall[] = [];
	const outcome = await workflow.run(makeCtx(1, calls) as never);

	assert.equal(outcome.status, "needs_human");
	assert.equal(
		calls.some((call) => call.name === "completion-reviewer-1"),
		false,
	);
	assert.match(String(outcome.remaining_work), /2: repair leaf 2/);
	assert.equal(existsSync(outcome.execution_report_path as string), true);
	const report = JSON.parse(readFileSync(outcome.execution_report_path as string, "utf8"));
	assert.equal(report.complete, false);
	assert.deepEqual(report.failed_leaf_ids, ["2"]);
	assert.deepEqual(report.blocked_leaf_ids, ["3"]);
	for (const record of report.records) {
		assert.equal(existsSync(record.task_artifact_path), true);
		assert.equal(existsSync(record.verification_artifact_path), true);
	}
});

test("a repair turn with mismatched exact check evidence cannot complete", async () => {
	const workflow = await importGoalWorkflow();
	const calls: TaskCall[] = [];
	const badRepairPlan = partialRepairPlan;
	const ctx = makeCtx(2, calls, badRepairPlan);
	ctx.task = async (name: string, options: WorkflowTaskOptions) => {
		calls.push({ name, options });
		if (name === "planner-1") return result(name, options, turnOnePlan);
		if (name === "planner-2") return result(name, options, badRepairPlan);
		if (name === "goal-turn-1-leaf-2-verify")
			return result(name, options, verificationFor(turnOnePlan, "2", "failed"));
		if (name === "goal-turn-2-leaf-1-verify") {
			return result(name, options, {
				...verificationFor(badRepairPlan, "1"),
				checks: [
					{
						command: "npm run check:two-repaired",
						expect: "two repaired ok",
						status: "passed",
						evidence: "different repair artifact",
					},
				],
			});
		}
		if (name.startsWith("goal-turn-1-") && name.endsWith("-verify")) {
			return result(name, options, verificationFor(turnOnePlan, name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
		}
		if (name.startsWith("goal-turn-2-") && name.endsWith("-verify")) {
			return result(name, options, verificationFor(badRepairPlan, name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
		}
		return result(name, options);
	};

	const outcome = await workflow.run(ctx as never);

	assert.equal(outcome.status, "needs_human");
	assert.equal(
		calls.some((call) => call.name === "completion-reviewer-2"),
		false,
	);
	const report = JSON.parse(readFileSync(outcome.execution_report_path as string, "utf8"));
	assert.equal(report.complete, false);
	assert.match(report.records[0].evidence, /did not match the frozen command\/expect pair/);
	assert.deepEqual(report.failed_leaf_ids, ["1"]);
	assert.deepEqual(report.blocked_leaf_ids, ["2", "3"]);
});
