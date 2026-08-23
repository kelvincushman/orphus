import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeRepeatedParallelCounts } from "../../packages/subagents/src/runs/foreground/subagent-executor-input.ts";

// The roundtable broker keys read cursors and message attribution purely on the
// session name. `count` + `name` on one task therefore used to produce N
// children sharing one identity: each digest marked messages read for all of
// them, and their posts merged under a single member.

test("a counted task's clones get distinct names, in order", () => {
	const normalized = normalizeRepeatedParallelCounts({
		tasks: [{ agent: "reviewer", task: "review it", name: "reviewer", count: 3 }],
	} as never);
	assert.ok(normalized.params);
	const tasks = (normalized.params as { tasks: Array<{ name?: string; count?: number }> }).tasks;
	assert.deepEqual(
		tasks.map((task) => task.name),
		["reviewer-1", "reviewer-2", "reviewer-3"],
	);
	assert.ok(
		tasks.every((task) => task.count === undefined),
		"count must not survive expansion",
	);
});

test("a single-count named task keeps its exact name", () => {
	const normalized = normalizeRepeatedParallelCounts({
		tasks: [
			{ agent: "reviewer", task: "review it", name: "reviewer", count: 1 },
			{ agent: "reviewer", task: "review it", name: "solo" },
		],
	} as never);
	assert.ok(normalized.params);
	const tasks = (normalized.params as { tasks: Array<{ name?: string }> }).tasks;
	assert.deepEqual(
		tasks.map((task) => task.name),
		["reviewer", "solo"],
	);
});

test("unnamed counted tasks expand without inventing names", () => {
	const normalized = normalizeRepeatedParallelCounts({
		tasks: [{ agent: "worker", task: "do it", count: 2 }],
	} as never);
	assert.ok(normalized.params);
	const tasks = (normalized.params as { tasks: Array<{ name?: string }> }).tasks;
	assert.equal(tasks.length, 2);
	assert.ok(tasks.every((task) => task.name === undefined));
});

test("chain parallel steps get the same distinct-name treatment", () => {
	const normalized = normalizeRepeatedParallelCounts({
		chain: [{ parallel: [{ agent: "critic", task: "judge", name: "critic", count: 2 }] }],
	} as never);
	assert.ok(normalized.params);
	const chain = (normalized.params as { chain: Array<{ parallel: Array<{ name?: string }> }> }).chain;
	assert.deepEqual(
		chain[0]?.parallel.map((task) => task.name),
		["critic-1", "critic-2"],
	);
});
