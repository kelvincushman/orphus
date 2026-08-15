import assert from "node:assert/strict";
import { test } from "vitest";
import {
	buildInterruptedParallelMessage,
	type InterruptedParallelTask,
} from "../../packages/subagents/src/runs/shared/parallel-utils.ts";

function task(agent: string, status: InterruptedParallelTask["status"]): InterruptedParallelTask {
	return { agent, status };
}

test("a task that failed is counted as finished, not as still running", () => {
	// The case that motivated this: one task fails before the deadline and one is
	// still going when it expires. Counting only `ok` reported "0/2 finished" and
	// named just the straggler — so the failure appeared in neither column and the
	// orchestrator was told less had happened than actually had.
	const text = buildInterruptedParallelMessage({
		results: [task("alpha", "error"), task("beta", "interrupted")],
		deadlineExpired: true,
		interruptedAgent: "beta",
	});

	assert.match(text, /1\/2 finished/);
	assert.match(text, /still running when time ran out: beta/);
	assert.doesNotMatch(text, /still running when time ran out:[^.]*alpha/);
});

test("every task lands in exactly one column", () => {
	// The property the count exists to hold. Statuses are enumerated rather than
	// sampled, so a new SubagentAttemptStatus that belongs in neither column
	// fails here instead of quietly skewing the number.
	const results = [
		task("ok-one", "ok"),
		task("err-one", "error"),
		task("skip-one", "skipped"),
		task("int-one", "interrupted"),
		task("cont-one", "continued"),
	];

	const text = buildInterruptedParallelMessage({ results, deadlineExpired: true, interruptedAgent: "int-one" });

	const finished = Number(text.match(/(\d+)\/5 finished/)?.[1]);
	const named = text.match(/still running when time ran out: ([^.]+)/)?.[1]?.split(", ") ?? [];
	assert.equal(finished, 2);
	assert.deepEqual(named, ["skip-one", "int-one", "cont-one"]);
	assert.equal(finished + named.length, results.length);
});

test("a run that beat its deadline names no stragglers", () => {
	const text = buildInterruptedParallelMessage({
		results: [task("alpha", "ok"), task("beta", "error")],
		deadlineExpired: true,
		interruptedAgent: "alpha",
	});

	assert.match(text, /2\/2 finished/);
	assert.doesNotMatch(text, /still running/);
});

test("a manual interrupt stays an answer, not a deadline report", () => {
	// A person who interrupted already knows why. Naming stragglers and counts at
	// them would read as a deadline the run never had.
	const text = buildInterruptedParallelMessage({
		results: [task("alpha", "ok"), task("beta", "interrupted")],
		deadlineExpired: false,
		interruptedAgent: "beta",
	});

	assert.match(text, /paused after interrupt \(beta\)/);
	assert.doesNotMatch(text, /deadline/);
	assert.doesNotMatch(text, /finished/);
});
