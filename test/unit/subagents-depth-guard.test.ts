import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
	checkSubagentDepth,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	getSubagentDepthEnv,
	MAX_SUBAGENT_NESTING_DEPTH,
	resolveChildMaxSubagentDepth,
	resolveWorkflowStageMaxSubagentDepth,
	subagentDepthBlockedMessage,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
} from "../../packages/subagents/src/shared/types.js";

const DEPTH_ENV = "ORPHUS_SUBAGENT_DEPTH";
const MAX_DEPTH_ENV = "ORPHUS_SUBAGENT_MAX_DEPTH";

const savedEnv = new Map<string, string | undefined>();
for (const key of [DEPTH_ENV, MAX_DEPTH_ENV, WORKFLOW_STAGE_SUBAGENT_GUARD_ENV]) {
	savedEnv.set(key, process.env[key]);
}

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("subagent workflow-stage depth guard", () => {
	test("workflow-stage context preserves stricter limits and defaults to main-chat depth", () => {
		delete process.env[DEPTH_ENV];
		delete process.env[MAX_DEPTH_ENV];
		delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		const workflowCtx = {
			orchestrationContext: {
				kind: "workflow-stage" as const,
				workflowRunId: "run-1",
				workflowStageId: "stage-1",
				workflowStageName: "Stage",
				constraints: { disableWorkflowTool: true as const, maxSubagentDepth: MAX_SUBAGENT_NESTING_DEPTH },
			},
		};
		const stricterWorkflowCtx = {
			orchestrationContext: {
				kind: "workflow-stage" as const,
				workflowRunId: "run-1",
				workflowStageId: "stage-1",
				workflowStageName: "Stage",
				constraints: { disableWorkflowTool: true as const, maxSubagentDepth: 0 },
			},
		};

		// A workflow constraint at the ceiling no longer wins: the default budget is
		// what the stage inherits, and the constraint can only narrow it.
		assert.equal(resolveWorkflowStageMaxSubagentDepth(workflowCtx, undefined), DEFAULT_SUBAGENT_MAX_DEPTH);
		assert.equal(resolveWorkflowStageMaxSubagentDepth(stricterWorkflowCtx, undefined), 1);
		assert.equal(resolveWorkflowStageMaxSubagentDepth(workflowCtx, 0), 0);
		assert.equal(resolveWorkflowStageMaxSubagentDepth({}, undefined), DEFAULT_SUBAGENT_MAX_DEPTH);
	});

	test("subagent nesting defaults to two levels and is still capped at five", () => {
		delete process.env[DEPTH_ENV];
		delete process.env[MAX_DEPTH_ENV];
		delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];

		// Pin the numbers themselves, not just their relationship. Every other
		// assertion here compares a resolved depth against these constants, so if
		// both the constant and the resolution moved together the suite would stay
		// green while the contract silently changed. WP 1.1 *is* the claim that the
		// default is 2 and the ceiling is 5.
		assert.equal(DEFAULT_SUBAGENT_MAX_DEPTH, 2);
		assert.equal(MAX_SUBAGENT_NESTING_DEPTH, 5);

		const result = checkSubagentDepth();
		assert.equal(result.blocked, false);
		assert.equal(result.depth, 0);
		assert.equal(result.maxDepth, DEFAULT_SUBAGENT_MAX_DEPTH);

		process.env[MAX_DEPTH_ENV] = String(MAX_SUBAGENT_NESTING_DEPTH + 10);
		assert.equal(checkSubagentDepth().maxDepth, MAX_SUBAGENT_NESTING_DEPTH);

		const firstChildEnv = getSubagentDepthEnv(MAX_SUBAGENT_NESTING_DEPTH + 10, { workflowStageSubagentGuard: true });
		assert.equal(firstChildEnv[DEPTH_ENV], "1");
		assert.equal(firstChildEnv[MAX_DEPTH_ENV], String(MAX_SUBAGENT_NESTING_DEPTH));
		assert.equal(firstChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV], "1");

		process.env[DEPTH_ENV] = firstChildEnv[DEPTH_ENV];
		process.env[MAX_DEPTH_ENV] = firstChildEnv[MAX_DEPTH_ENV];
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = firstChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		const firstChildResult = checkSubagentDepth();
		assert.equal(firstChildResult.blocked, false);
		assert.equal(firstChildResult.depth, 1);
		assert.equal(firstChildResult.maxDepth, MAX_SUBAGENT_NESTING_DEPTH);

		const secondChildEnv = getSubagentDepthEnv(MAX_SUBAGENT_NESTING_DEPTH, { workflowStageSubagentGuard: true });
		assert.equal(secondChildEnv[DEPTH_ENV], "2");
		assert.equal(secondChildEnv[MAX_DEPTH_ENV], String(MAX_SUBAGENT_NESTING_DEPTH));
	});

	test("the env var raises the default; an agent definition can only lower it", () => {
		delete process.env[DEPTH_ENV];
		delete process.env[MAX_DEPTH_ENV];
		delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];

		// Raising is a deliberate act, and the env var is where it happens.
		process.env[MAX_DEPTH_ENV] = "4";
		assert.equal(checkSubagentDepth().maxDepth, 4);
		// Still clamped by the ceiling, however loudly you ask.
		process.env[MAX_DEPTH_ENV] = "99";
		assert.equal(checkSubagentDepth().maxDepth, MAX_SUBAGENT_NESTING_DEPTH);
		delete process.env[MAX_DEPTH_ENV];

		// An agent's own maxSubagentDepth min-clamps against the budget its parent
		// was granted, so it narrows its subtree and never widens it. Declaring 4
		// under a parent budget of 2 yields 2 — worth pinning, because it is the
		// opposite of what "an override" suggests. Literal depths throughout, so
		// these keep their meaning even if a constant moves.
		assert.equal(resolveChildMaxSubagentDepth(2, 4), 2);
		assert.equal(resolveChildMaxSubagentDepth(2, 1), 1);
		assert.equal(resolveChildMaxSubagentDepth(2, undefined), 2);
		// Given a wider parent budget, a narrower agent value still wins.
		assert.equal(resolveChildMaxSubagentDepth(5, 3), 3);
	});

	test("workflow-stage child env marker produces nested workflow-stage rejection message", () => {
		delete process.env[DEPTH_ENV];
		delete process.env[MAX_DEPTH_ENV];
		delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];

		const firstChildEnv = getSubagentDepthEnv(2, { workflowStageSubagentGuard: true });
		process.env[DEPTH_ENV] = firstChildEnv[DEPTH_ENV];
		process.env[MAX_DEPTH_ENV] = firstChildEnv[MAX_DEPTH_ENV];
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = firstChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		const secondChildEnv = getSubagentDepthEnv(2, { workflowStageSubagentGuard: true });
		assert.equal(secondChildEnv[DEPTH_ENV], "2");
		assert.equal(secondChildEnv[MAX_DEPTH_ENV], "2");
		assert.equal(secondChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV], "1");

		process.env[DEPTH_ENV] = secondChildEnv[DEPTH_ENV];
		process.env[MAX_DEPTH_ENV] = secondChildEnv[MAX_DEPTH_ENV];
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = secondChildEnv[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		const result = checkSubagentDepth();
		assert.equal(result.blocked, true);
		assert.equal(result.workflowStageGuard, true);
		assert.match(
			subagentDepthBlockedMessage(result.depth, result.maxDepth, { workflowStageGuard: true }),
			/Sub-agents inside workflow stages are running at the maximum nesting depth/,
		);
	});
});
