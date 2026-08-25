import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, test } from "vitest";
import type {
	WorkflowDefinition,
	WorkflowTaskOptions,
	WorkflowTaskResult,
	WorkflowTaskStep,
} from "../../packages/workflows/src/shared/types.js";
import { createStore, run, structuredOutputMockSession } from "./executor-shared.js";

type TaskCall = {
	readonly name: string;
	readonly options: WorkflowTaskOptions;
};

type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settled) => {
		resolve = settled;
	});
	return { promise, resolve };
}

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

function reviewDecision() {
	return {
		findings: [],
		overall_correctness: "patch is correct",
		overall_explanation: "goal plan, execution report, and verification artifacts prove completion",
		overall_confidence_score: 0.9,
		goal_oracle_satisfied: true,
		requirements_traceability: [
			{
				requirement: "finish objective",
				status: "proven",
				evidence: "all leaf verification artifacts passed",
			},
		],
		receipt_assessment: "direct evidence artifacts corroborate the receipts",
		verification_remaining: "none",
		stop_review_loop: true,
		reviewer_error: null,
	};
}

const plan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "Foundation",
			task: "Implement foundation",
			owns: ["packages/foundation.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "npm run check:foundation", expect: "foundation ok" }],
		},
		{
			id: "2",
			title: "Unrelated long leaf",
			task: "Implement unrelated work",
			owns: ["packages/unrelated.ts"],
			needs: [],
			tier: "fast",
			checks: [{ command: "npm run check:unrelated", expect: "unrelated ok" }],
		},
		{
			id: "3",
			title: "Unlocked dependant",
			task: "Implement after foundation",
			owns: ["packages/dependant.ts"],
			needs: ["1"],
			tier: "judgment",
			checks: [{ command: "npm run check:dependant", expect: "dependant ok" }],
		},
	],
} as const;

const overlapPlan = {
	version: 1,
	leaves: [
		{ ...plan.leaves[0], owns: ["packages/shared.ts"] },
		{ ...plan.leaves[1], owns: ["packages/shared.ts"] },
		plan.leaves[2],
	],
} as const;

const cyclePlan = {
	version: 1,
	leaves: [{ ...plan.leaves[0], needs: ["3"] }, plan.leaves[1], { ...plan.leaves[2], needs: ["1"] }],
} as const;

function verification(
	leafId: string,
	overrides: Partial<{
		status: "verified" | "failed" | "blocked";
		evidence: string;
		remaining_work: string;
		checks: readonly { command: string; expect: string; status: "passed" | "failed" | "blocked"; evidence: string }[];
	}> = {},
) {
	const leaf = plan.leaves.find((candidate) => candidate.id === leafId);
	assert.ok(leaf, `unknown leaf ${leafId}`);
	return {
		status: overrides.status ?? "verified",
		evidence: overrides.evidence ?? `leaf ${leafId} verified with current command evidence`,
		remaining_work: overrides.remaining_work ?? "none",
		checks:
			overrides.checks ??
			leaf.checks.map((check) => ({
				command: check.command,
				expect: check.expect,
				status: "passed" as const,
				evidence: `${check.command} produced ${check.expect}`,
			})),
	};
}

function workflowInputs(overrides: Record<string, unknown> = {}) {
	return {
		objective: "Complete the public Goal workflow adversarial task",
		min_team_size: 3,
		max_team_size: 24,
		max_parallel_agents: 2,
		max_turns: 1,
		base_branch: "origin/main",
		git_worktree_dir: "",
		create_pr: false,
		...overrides,
	};
}

async function importGoalWorkflow(): Promise<WorkflowDefinition> {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	return mod.default as unknown as WorkflowDefinition;
}

async function waitForCall(calls: readonly TaskCall[], name: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (calls.some((call) => call.name === name)) return;
		await setTimeout(5);
	}
	throw new Error(`task ${name} was not called`);
}

function makePublicCtx(inputPlan: WorkflowTaskResult["structured"], calls: TaskCall[] = []) {
	return {
		inputs: workflowInputs(),
		runId: crypto.randomUUID(),
		cwd: process.cwd(),
		task: async (name: string, options: WorkflowTaskOptions) => {
			calls.push({ name, options });
			if (name === "planner-1") return result(name, options, inputPlan);
			if (name.endsWith("-verify"))
				return result(name, options, verification(name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
			return result(name, options);
		},
		parallel: async (steps: readonly WorkflowTaskStep[]) =>
			steps.map((step) => result(step.name, step, reviewDecision())),
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

describe("Goal core completion public adversarial behavior", () => {
	test("runtime-style objective-only invocation resolves schema defaults and enters native planner mode", async () => {
		const workflow = await importGoalWorkflow();
		const stageNames: string[] = [];
		const wfResult = await run(
			workflow,
			{ objective: "Runtime default Goal should use the native team planner" },
			{
				adapters: {
					agentSession: {
						async create(options, meta) {
							const stageName = meta?.stageName ?? "unknown";
							stageNames.push(stageName);
							const payload =
								stageName === "planner-1"
									? plan
									: stageName.endsWith("-verify")
										? verification(stageName.match(/leaf-([^-]+)/)?.[1] ?? "1")
										: reviewDecision();
							return structuredOutputMockSession(options, payload);
						},
					},
				},
				store: createStore(),
			},
		);

		assert.equal(wfResult.status, "completed");
		assert.equal(wfResult.result?.status, "complete");
		assert.equal(stageNames.includes("planner-1"), true);
		assert.equal(stageNames.includes("orchestrator-1"), false);
		assert.equal(stageNames.filter((name) => name.startsWith("goal-turn-1-leaf-")).length, 6);
	});

	test("public Goal rejects malformed team and concurrency bounds before planning", async () => {
		const workflow = await importGoalWorkflow();
		const cases = [
			["min_team_size", null],
			["min_team_size", 2],
			["min_team_size", 3.5],
			["min_team_size", 25],
			["max_team_size", null],
			["max_team_size", 2],
			["max_team_size", 3.5],
			["max_team_size", 25],
			["max_parallel_agents", null],
			["max_parallel_agents", Number.NaN],
			["max_parallel_agents", Number.POSITIVE_INFINITY],
			["max_parallel_agents", 0],
			["max_parallel_agents", 1.5],
			["max_parallel_agents", 11],
		] as const;

		for (const [inputName, value] of cases) {
			const calls: TaskCall[] = [];
			const ctx = {
				...makePublicCtx(plan, calls),
				inputs: workflowInputs({ [inputName]: value }),
			};
			await assert.rejects(
				async () => await workflow.run(ctx as never),
				new RegExp(`goal ${inputName} must be an integer between`),
			);
			assert.deepEqual(calls, [], inputName);
		}

		const invertedCalls: TaskCall[] = [];
		const invertedCtx = {
			...makePublicCtx(plan, invertedCalls),
			inputs: workflowInputs({ min_team_size: 10, max_team_size: 5 }),
		};
		await assert.rejects(
			async () => await workflow.run(invertedCtx as never),
			/min_team_size \(10\).*greater than max_team_size \(5\)/,
		);
		assert.deepEqual(invertedCalls, []);
	});

	for (const [caseName, invalidPlan, evidencePattern] of [
		["overlap", overlapPlan, /Ownership overlap/i],
		["cycle", cyclePlan, /Dependency cycle/i],
	] as const) {
		test(`planner ${caseName} fails closed without worker verifier or legacy fallback`, async () => {
			const workflow = await importGoalWorkflow();
			const calls: TaskCall[] = [];
			const ctx = makePublicCtx(invalidPlan, calls);

			const outcome = await workflow.run(ctx as never);

			assert.equal(outcome.status, "needs_human");
			assert.deepEqual(
				calls.map((call) => call.name),
				["planner-1"],
			);
			assert.equal(
				calls.some((call) => call.name === "orchestrator-1"),
				false,
			);
			assert.equal(
				calls.some((call) => call.name.startsWith("goal-turn-1-leaf-")),
				false,
			);
			assert.match(String(outcome.remaining_work), evidencePattern);
			assert.equal(typeof outcome.execution_plan_path, "string");
			assert.equal(existsSync(outcome.execution_plan_path as string), true);
			assert.match(readFileSync(outcome.execution_plan_path as string, "utf8"), evidencePattern);
			assert.equal(typeof outcome.execution_report_path, "undefined");
			assert.equal(existsSync(outcome.ledger_path as string), true);
			const ledger = JSON.parse(readFileSync(outcome.ledger_path as string, "utf8"));
			assert.match(ledger.decisions[0].reason, /Max turn budget reached before a valid team plan/i);
		});
	}

	test("public rolling execution starts a dependant after its dependency verifies while an unrelated leaf is still in flight", async () => {
		const workflow = await importGoalWorkflow();
		const calls: TaskCall[] = [];
		const worker1 = deferred<WorkflowTaskResult>();
		const worker2 = deferred<WorkflowTaskResult>();
		const worker3 = deferred<WorkflowTaskResult>();
		const workers = new Map([
			["goal-turn-1-leaf-1", worker1],
			["goal-turn-1-leaf-2", worker2],
			["goal-turn-1-leaf-3", worker3],
		]);
		const ctx = makePublicCtx(plan, calls);
		ctx.task = async (name: string, options: WorkflowTaskOptions) => {
			calls.push({ name, options });
			if (name === "planner-1") return result(name, options, plan);
			const worker = workers.get(name);
			if (worker !== undefined) return worker.promise;
			if (name.endsWith("-verify"))
				return result(name, options, verification(name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
			return result(name, options);
		};

		const runPromise = workflow.run(ctx as never);
		await waitForCall(calls, "goal-turn-1-leaf-2");
		assert.deepEqual(
			calls.map((call) => call.name),
			["planner-1", "goal-turn-1-leaf-1", "goal-turn-1-leaf-2"],
		);
		worker1.resolve(result("goal-turn-1-leaf-1", calls[1].options));
		await waitForCall(calls, "goal-turn-1-leaf-3");
		assert.deepEqual(
			calls.map((call) => call.name),
			["planner-1", "goal-turn-1-leaf-1", "goal-turn-1-leaf-2", "goal-turn-1-leaf-1-verify", "goal-turn-1-leaf-3"],
		);

		worker2.resolve(result("goal-turn-1-leaf-2", calls[2].options));
		worker3.resolve(result("goal-turn-1-leaf-3", calls[4].options));
		const outcome = await runPromise;

		assert.equal(outcome.status, "complete");
		assert.equal(existsSync(outcome.execution_report_path as string), true);
		const report = JSON.parse(readFileSync(outcome.execution_report_path as string, "utf8"));
		assert.equal(report.complete, true);
		assert.deepEqual(report.failed_leaf_ids, []);
		assert.deepEqual(report.blocked_leaf_ids, []);
	});

	test("public workflow blocks dependency dispatch and rejects stale mismatched contradictory verifier evidence", async () => {
		const workflow = await importGoalWorkflow();
		const hostileCases = [
			{
				name: "failed dependency",
				verify: verification("1", {
					status: "failed",
					evidence: "foundation check failed; repair foundation",
					remaining_work: "repair foundation",
					checks: [{ ...plan.leaves[0].checks[0], status: "failed" as const, evidence: "failed current check" }],
				}),
				evidence: /repair foundation/,
				blocked: ["3"],
			},
			{
				name: "missing checks",
				verify: verification("1", { checks: [] }),
				evidence: /0 check results for 1 declared checks/,
				blocked: ["3"],
			},
			{
				name: "stale mismatched check",
				verify: verification("1", {
					checks: [{ command: "npm run old-check", expect: "old ok", status: "passed", evidence: "old output" }],
				}),
				evidence: /did not match the frozen command\/expect pair/,
				blocked: ["3"],
			},
			{
				name: "contradictory remaining work",
				verify: verification("1", { remaining_work: "still missing an exact gate" }),
				evidence: /contradicted itself/,
				blocked: ["3"],
			},
		] as const;

		for (const hostileCase of hostileCases) {
			const calls: TaskCall[] = [];
			const ctx = makePublicCtx(plan, calls);
			ctx.task = async (name: string, options: WorkflowTaskOptions) => {
				calls.push({ name, options });
				if (name === "planner-1") return result(name, options, plan);
				if (name === "goal-turn-1-leaf-1-verify") return result(name, options, hostileCase.verify);
				if (name.endsWith("-verify"))
					return result(name, options, verification(name.match(/leaf-([^-]+)/)?.[1] ?? "1"));
				return result(name, options);
			};

			const outcome = await workflow.run(ctx as never);

			assert.equal(outcome.status, "needs_human", hostileCase.name);
			assert.equal(
				calls.some((call) => call.name === "goal-turn-1-leaf-3"),
				false,
				hostileCase.name,
			);
			assert.equal(
				calls.some((call) => call.name === "completion-reviewer-1"),
				false,
				hostileCase.name,
			);
			const report = JSON.parse(readFileSync(outcome.execution_report_path as string, "utf8"));
			assert.deepEqual(report.blocked_leaf_ids, hostileCase.blocked, hostileCase.name);
			const failed = report.records.find((record: { leaf_id: string }) => record.leaf_id === "1");
			assert.match(failed.evidence, hostileCase.evidence, hostileCase.name);
			assert.equal(
				existsSync(report.records.find((record: { leaf_id: string }) => record.leaf_id === "3").task_artifact_path),
				true,
			);
			assert.equal(
				existsSync(
					report.records.find((record: { leaf_id: string }) => record.leaf_id === "3").verification_artifact_path,
				),
				true,
			);
		}
	});
});
