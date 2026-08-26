// @ts-nocheck

import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
	goalLeafModelConfig,
	orchestratorModelConfig as goalOrchestratorModelConfig,
	reviewerModelConfigs as goalReviewerModelConfigs,
} from "../../packages/workflows/builtin/goal-models.js";
import { reviewDecisionSchema } from "../../packages/workflows/builtin/goal-schemas.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

const nativeInputs = {
	objective: "Delegate implementation",
	min_team_size: 3,
	max_team_size: 24,
	max_parallel_agents: 3,
	max_turns: 1,
};

const plan = {
	version: 1,
	leaves: [
		{
			id: "1",
			title: "One",
			task: "Do one",
			owns: ["one.ts"],
			needs: [],
			tier: "judgment",
			checks: [{ command: "check one", expect: "one passes" }],
		},
		{
			id: "2",
			title: "Two",
			task: "Do two",
			owns: ["two.ts"],
			needs: [],
			tier: "standard",
			checks: [{ command: "check two", expect: "two passes" }],
		},
		{
			id: "3",
			title: "Three",
			task: "Do three",
			owns: ["three.ts"],
			needs: ["1", "2"],
			tier: "fast",
			checks: [{ command: "check three", expect: "three passes" }],
		},
	],
} as const;

function taskResponder(name: string): string | undefined {
	if (name === "planner-1") return JSON.stringify(plan);
	if (name.endsWith("-verify")) {
		const leafId = name.match(/leaf-([^-]+)/)?.[1] ?? "1";
		const leaf = plan.leaves.find((candidate) => candidate.id === leafId) ?? plan.leaves[0]!;
		const check = leaf.checks[0]!;
		return JSON.stringify({
			status: "verified",
			evidence: `${leafId} verified`,
			remaining_work: "none",
			checks: [
				{ command: check.command, expect: check.expect, status: "passed", evidence: `${check.command} passed` },
			],
		});
	}
	if (name.endsWith("reviewer-1")) {
		return JSON.stringify({
			findings: [],
			overall_correctness: "patch is correct",
			overall_explanation: "reviewed",
			overall_confidence_score: 0.9,
			goal_oracle_satisfied: true,
			requirements_traceability: [
				{ requirement: "complete objective", status: "proven", evidence: "verified leaves" },
			],
			receipt_assessment: "receipts corroborated",
			verification_remaining: "none",
			stop_review_loop: true,
			reviewer_error: null,
		});
	}
	return undefined;
}

test("Goal planner prefers Fable 5 with ordered cross-provider fallbacks", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx(nativeInputs, { task: taskResponder });

	await workflow.run(ctx);

	const options = ctx.calls.taskOptions["planner-1"]?.[0];
	assert.ok(options, "missing Goal planner options");
	assert.equal(options.model, "anthropic/claude-fable-5:high");
	assert.equal(goalOrchestratorModelConfig.model, "anthropic/claude-fable-5:high");
	assert.deepEqual(options.excludedTools, ["ask_user_question"]);
	assert.equal(options.fallbackModels?.includes("openai-codex/gpt-5.6-sol:xhigh"), true);
	assert.equal(options.fallbackModels?.includes("kimi-coding/k3:max"), true);
	assert.equal(options.fallbackModels?.includes("zai/glm-5.2:xhigh"), true);
});

test("Goal reviewers use decorrelated primary models with the review schema preserved", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx({ ...nativeInputs, objective: "Review independently" }, { task: taskResponder });

	await workflow.run(ctx);

	const reviewerNames = ["completion-reviewer-1", "evidence-reviewer-1", "risk-reviewer-1"];
	const primaryModels = reviewerNames.map((name) => ctx.calls.taskOptions[name]?.[0]?.model);
	assert.deepEqual(
		primaryModels,
		goalReviewerModelConfigs.map((config) => config.model),
	);
	assert.equal(new Set(primaryModels).size, 3);

	for (const [index, name] of reviewerNames.entries()) {
		const options = ctx.calls.taskOptions[name]?.[0];
		assert.ok(options, `missing options for ${name}`);
		assert.equal(options.context, undefined, name);
		assert.equal(options.forkFromSessionFile, undefined, name);
		assert.equal(options.model, goalReviewerModelConfigs[index].model, name);
		assert.deepEqual(options.fallbackModels, goalReviewerModelConfigs[index].fallbackModels, name);
		assert.deepEqual(options.excludedTools, goalReviewerModelConfigs[index].excludedTools, name);
		const fallbacks = options.fallbackModels ?? [];
		assert.equal(
			fallbacks.includes("anthropic/claude-fable-5:high"),
			options.model !== "anthropic/claude-fable-5:high",
			name,
		);
		assert.equal(
			fallbacks.includes("openai-codex/gpt-5.6-sol:xhigh"),
			options.model !== "openai-codex/gpt-5.6-sol:xhigh",
			name,
		);
		assert.equal(fallbacks.includes("kimi-coding/k3:max"), options.model !== "kimi-coding/k3:max", name);
		assert.equal(options.schema, reviewDecisionSchema, name);
	}
});

test("Goal leaf model pool rotates tiers across model families while preserving fallbacks", () => {
	const judgment = [0, 1, 2, 3].map((index) => goalLeafModelConfig("judgment", index).model);
	const standard = [0, 1, 2, 3].map((index) => goalLeafModelConfig("standard", index).model);
	const fast = [0, 1, 2, 3].map((index) => goalLeafModelConfig("fast", index).model);

	assert.equal(new Set(judgment).size, 4);
	assert.equal(new Set(standard).size, 4);
	assert.equal(new Set(fast).size, 4);
	assert.equal(judgment[0], "anthropic/claude-fable-5:high");
	assert.equal(standard.includes("openai-codex/gpt-5.6-sol:xhigh"), true);
	assert.equal(fast.includes("kimi-coding/k3:max"), true);
	assert.deepEqual(goalLeafModelConfig("judgment", 0).excludedTools, ["ask_user_question"]);
	assert.equal(goalLeafModelConfig("judgment", 0).fallbackModels.includes("openai-codex/gpt-5.6-sol:xhigh"), true);
});

test("Goal reviewer schema accepts the decision fields consumed by its gate", () => {
	assert.equal(
		Value.Check(reviewDecisionSchema, {
			findings: [],
			overall_correctness: "patch is correct",
			overall_explanation: "all requirements proven",
			overall_confidence_score: 0.9,
			goal_oracle_satisfied: true,
			requirements_traceability: [
				{
					requirement: "complete objective",
					status: "proven",
					evidence: "focused checks passed",
				},
			],
			receipt_assessment: "receipt corroborated",
			verification_remaining: "none",
			stop_review_loop: true,
			reviewer_error: null,
		}),
		true,
	);
});
