import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { makeMockCtx, normalizePathSeparators, readPaths } from "./builtin-workflows-helpers.js";

function reviewJson(): string {
	return JSON.stringify({
		findings: [],
		overall_correctness: "patch is correct",
		overall_explanation: "planned leaves and execution report inspected",
		overall_confidence_score: 0.9,
		goal_oracle_satisfied: true,
		requirements_traceability: [
			{
				requirement: "complete requested objective",
				status: "proven",
				evidence: "execution report verified every leaf",
			},
		],
		receipt_assessment: "execution plan, execution report, and leaf verifications corroborated",
		verification_remaining: "none",
		stop_review_loop: true,
		reviewer_error: null,
	});
}

function verifierJson(leafId: string, status: "verified" | "failed" = "verified"): string {
	return verifierJsonForPlan(executionPlan, leafId, status);
}

function repairVerifierJson(leafId: string): string {
	return verifierJsonForPlan(repairPlan, leafId, "verified");
}

function verifierJsonForPlan(
	plan: typeof executionPlan | typeof repairPlan,
	leafId: string,
	status: "verified" | "failed",
): string {
	const leaf = plan.leaves.find((candidate) => candidate.id === leafId);
	assert.ok(leaf, `missing test leaf ${leafId}`);
	const check = leaf.checks[0]!;
	return JSON.stringify({
		status,
		evidence: status === "verified" ? `${leafId} owned files and command evidence checked` : `${leafId} check failed`,
		remaining_work: status === "verified" ? "none" : `repair leaf ${leafId}`,
		checks: [
			{
				command: check.command,
				expect: check.expect,
				status: status === "verified" ? "passed" : "failed",
				evidence: `${check.command} observed for ${leafId}`,
			},
		],
	});
}

const executionPlan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "First ready leaf",
			task: "Implement first leaf",
			owns: ["packages/first.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "npm run check:first", expect: "First check passes" }],
		},
		{
			id: "2",
			title: "Second ready leaf",
			task: "Implement second leaf",
			owns: ["packages/second.ts"],
			needs: [],
			tier: "fast",
			checks: [{ command: "npm run check:second", expect: "Second check passes" }],
		},
		{
			id: "3",
			title: "Judgment follow-up",
			task: "Integrate the ready leaves",
			owns: ["packages/third.ts"],
			needs: ["1", "2"],
			tier: "judgment",
			checks: [{ command: "npm run check:third", expect: "Third check passes" }],
		},
	],
} as const;

const repairPlan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "Repair failed leaf",
			task: "Repair first turn failure",
			owns: ["packages/repair.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "npm run check:repair", expect: "Repair check passes" }],
		},
		{
			id: "2",
			title: "Regression guard",
			task: "Verify repair regression",
			owns: ["test/repair.test.ts"],
			needs: ["1"],
			tier: "fast",
			checks: [{ command: "npm run check:repair-test", expect: "Repair regression passes" }],
		},
		{
			id: "3",
			title: "Evidence closeout",
			task: "Close evidence gaps",
			owns: ["docs/repair.md"],
			needs: ["2"],
			tier: "judgment",
			checks: [{ command: "npm run check:repair-docs", expect: "Repair docs pass" }],
		},
	],
} as const;

function plannedInputs(overrides: Record<string, unknown> = {}) {
	return {
		objective: "Implement through a team",
		min_team_size: 3,
		max_team_size: 24,
		max_parallel_agents: 3,
		max_turns: 1,
		...overrides,
	};
}

test("Goal uses structured depth plan and rolling leaf execution as the core work path", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(plannedInputs(), {
		task: (name) => {
			if (name === "planner-1") return JSON.stringify(executionPlan);
			if (name.endsWith("-verify")) return verifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
			if (name.endsWith("reviewer-1")) return reviewJson();
			return `${name} receipt`;
		},
	});

	const result = await workflow.run(ctx);

	assert.equal(ctx.calls.task.includes("planner-1"), true);
	assert.equal(ctx.calls.task.includes("orchestrator-1"), false);
	assert.deepEqual(
		ctx.calls.task.filter((name) => name.startsWith("goal-turn-1-leaf-") && !name.endsWith("-verify")),
		["goal-turn-1-leaf-1", "goal-turn-1-leaf-2", "goal-turn-1-leaf-3"],
	);
	assert.equal(ctx.calls.taskOptions["goal-turn-1-leaf-1"]?.[0]?.model, "openai-codex/gpt-5.6-sol:xhigh");
	assert.equal(ctx.calls.taskOptions["goal-turn-1-leaf-2"]?.[0]?.model, "anthropic/claude-fable-5:low");
	assert.equal(ctx.calls.taskOptions["goal-turn-1-leaf-3"]?.[0]?.model, "kimi-coding/k3:max");
	assert.equal(result.status, "complete");
	assert.equal(typeof result.execution_plan_path, "string");
	assert.equal(typeof result.execution_report_path, "string");
	assert.equal(existsSync(result.execution_plan_path as string), true);
	assert.equal(existsSync(result.execution_report_path as string), true);
});

test("native invalid plan fails closed without legacy fallback or worker launch", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(plannedInputs({ max_turns: 1 }), {
		task: (name) => (name === "planner-1" ? JSON.stringify({ version: 1, leaves: [] }) : `${name} receipt`),
	});

	const result = await workflow.run(ctx);

	assert.equal(result.status, "needs_human");
	assert.deepEqual(ctx.calls.task, ["planner-1"]);
	assert.equal(ctx.calls.parallel.length, 0);
	assert.match(String(result.remaining_work), /invalid execution plan/i);
	assert.equal(ctx.calls.task.includes("orchestrator-1"), false);
});

test("native repair planning reads the preserved invalid plan artifact", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(plannedInputs({ max_turns: 2 }), {
		task: (name, options) => {
			if (name === "planner-1") return JSON.stringify({ version: 1, leaves: [] });
			if (name === "planner-2") {
				const reads = readPaths(options).map(normalizePathSeparators);
				assert.ok(reads.some((path) => /goal-execution-plan-turn-1\.json$/.test(path)));
				return JSON.stringify(executionPlan);
			}
			if (name.endsWith("-verify")) return verifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
			if (name.endsWith("reviewer-2")) return reviewJson();
			return `${name} receipt`;
		},
	});

	const result = await workflow.run(ctx);

	assert.equal(result.status, "complete");
	assert.deepEqual(
		ctx.calls.task.filter((name) => name.startsWith("planner-")),
		["planner-1", "planner-2"],
	);
	const firstPlanPath = String(result.execution_plan_path).replace(/turn-2\.json$/, "turn-1.json");
	const firstPlanArtifact = JSON.parse(readFileSync(firstPlanPath, "utf8")) as {
		error: string;
		proposed_plan: unknown;
	};
	assert.match(firstPlanArtifact.error, /invalid execution plan/i);
	assert.deepEqual(firstPlanArtifact.proposed_plan, { version: 1, leaves: [] });
});

test("native incomplete turn feeds execution evidence into the next repair plan", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(plannedInputs({ max_turns: 2 }), {
		task: (name, options) => {
			if (name === "planner-1") return JSON.stringify(executionPlan);
			if (name === "planner-2") {
				const reads = readPaths(options).map(normalizePathSeparators);
				assert.ok(reads.some((path) => /goal-execution-plan-turn-1\.json$/.test(path)));
				assert.ok(reads.some((path) => /turn-1-goal-execution-report\.json$/.test(path)));
				assert.ok(reads.some((path) => /turn-1-leaf-2-verification\.json$/.test(path)));
				return JSON.stringify(repairPlan);
			}
			if (name === "goal-turn-1-leaf-2-verify") return verifierJson("2", "failed");
			if (name.startsWith("goal-turn-2-") && name.endsWith("-verify")) {
				return repairVerifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
			}
			if (name.endsWith("-verify")) return verifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
			if (name.endsWith("reviewer-2")) return reviewJson();
			return `${name} receipt`;
		},
	});

	const result = await workflow.run(ctx);

	assert.equal(result.status, "complete");
	assert.equal(ctx.calls.task.includes("planner-2"), true);
	assert.equal(ctx.calls.task.includes("completion-reviewer-1"), false);
	assert.equal(ctx.calls.task.includes("completion-reviewer-2"), true);
});

test("native incomplete execution on max turn stops as needs_human", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(plannedInputs({ max_turns: 1 }), {
		task: (name) => {
			if (name === "planner-1") return JSON.stringify(executionPlan);
			if (name === "goal-turn-1-leaf-2-verify") return verifierJson("2", "failed");
			if (name.endsWith("-verify")) return verifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
			return `${name} receipt`;
		},
	});

	const result = await workflow.run(ctx);

	assert.equal(result.status, "needs_human");
	assert.equal(ctx.calls.task.includes("completion-reviewer-1"), false);
	assert.match(String(result.remaining_work), /2: repair leaf 2/);
});

test("final reviewers directly read plan report and every leaf verification artifact", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(plannedInputs(), {
		task: (name) => {
			if (name === "planner-1") return JSON.stringify(executionPlan);
			if (name.endsWith("-verify")) return verifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
			if (name.endsWith("reviewer-1")) return reviewJson();
			return `${name} receipt`;
		},
	});

	await workflow.run(ctx);

	const reviewerOptions = ctx.calls.taskOptions["completion-reviewer-1"]?.[0];
	assert.ok(reviewerOptions);
	const reads = readPaths(reviewerOptions).map(normalizePathSeparators);
	assert.ok(reads.some((path) => /goal-ledger\.json$/.test(path)));
	assert.ok(reads.some((path) => /goal-execution-plan-turn-1\.json$/.test(path)));
	assert.ok(reads.some((path) => /turn-1-goal-execution-report\.json$/.test(path)));
	assert.equal(reads.filter((path) => /turn-1-leaf-\d+-verification\.json$/.test(path)).length, 3);
	assert.match(
		ctx.calls.prompts["completion-reviewer-1"]?.[0] ?? "",
		/Directly read every immutable evidence artifact/,
	);
});

test("direct call without team inputs defaults to native planned execution", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(
		{ objective: "Native direct call", max_turns: 1 },
		{
			task: (name) => {
				if (name === "planner-1") return JSON.stringify(executionPlan);
				if (name.endsWith("-verify")) return verifierJson(name.match(/leaf-([^-]+)/)?.[1] ?? "1");
				if (name.endsWith("reviewer-1")) return reviewJson();
				return `${name} receipt`;
			},
		},
	);

	const result = await workflow.run(ctx);
	const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
		receipts: readonly { stage: string }[];
	};

	assert.equal(ctx.calls.task.includes("planner-1"), true);
	assert.equal(ctx.calls.task.includes("orchestrator-1"), false);
	assert.ok(ledger.receipts.some((receipt) => receipt.stage === "execution-plan-1"));
	assert.ok(ledger.receipts.some((receipt) => receipt.stage === "execution-team-1"));
	assert.equal(result.status, "complete");
});

test("explicit legacy_orchestrator true uses the deprecated orchestrator path", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(
		{ objective: "Legacy direct call", max_turns: 1, legacy_orchestrator: true },
		{
			task: (name) => {
				if (name.endsWith("reviewer-1")) return reviewJson();
				return `${name} receipt`;
			},
		},
	);

	const result = await workflow.run(ctx);
	const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
		receipts: readonly { stage: string }[];
	};

	assert.equal(ctx.calls.task.includes("planner-1"), false);
	assert.deepEqual(
		ctx.calls.task.filter((name) => name === "orchestrator-1"),
		["orchestrator-1"],
	);
	assert.ok(ledger.receipts.some((receipt) => receipt.stage === "orchestrator-1"));
	assert.equal(result.status, "complete");
});
