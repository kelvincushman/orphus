import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	aggregateParallelOutputs,
	digestParallelOutputs,
	orderForDigest,
	type ParallelTaskResult,
} from "../../packages/subagents/src/runs/shared/parallel-utils.js";

function task(overrides: Partial<ParallelTaskResult> & { agent: string }): ParallelTaskResult {
	return {
		output: "",
		status: "ok",
		...overrides,
	} as ParallelTaskResult;
}

/** Four children each emitting 100 KB — the acceptance criterion's shape. */
function fourBigChildren(): ParallelTaskResult[] {
	return [
		task({ agent: "alpha", taskIndex: 0, output: "a".repeat(100_000), artifactOutputPath: "/artifacts/alpha.md" }),
		task({ agent: "bravo", taskIndex: 1, output: "b".repeat(100_000), artifactOutputPath: "/artifacts/bravo.md" }),
		task({
			agent: "charlie",
			taskIndex: 2,
			output: "c".repeat(100_000),
			artifactOutputPath: "/artifacts/charlie.md",
		}),
		task({ agent: "delta", taskIndex: 3, output: "d".repeat(100_000), artifactOutputPath: "/artifacts/delta.md" }),
	];
}

describe("parallel digest ordering", () => {
	test("failures first, then task order", () => {
		const ordered = orderForDigest([
			task({ agent: "ok-late", taskIndex: 3 }),
			task({ agent: "failed", taskIndex: 2, status: "error", error: "boom" }),
			task({ agent: "ok-early", taskIndex: 0 }),
			task({ agent: "warned", taskIndex: 1, error: "degraded" }),
		]);
		assert.deepEqual(
			ordered.map((r) => r.agent),
			["failed", "warned", "ok-early", "ok-late"],
		);
	});

	test("ties break on task order, so equal outcomes keep the caller's sequence", () => {
		const ordered = orderForDigest([
			task({ agent: "third", taskIndex: 2 }),
			task({ agent: "first", taskIndex: 0 }),
			task({ agent: "second", taskIndex: 1 }),
		]);
		assert.deepEqual(
			ordered.map((r) => r.agent),
			["first", "second", "third"],
		);
	});
});

describe("digestParallelOutputs", () => {
	test("four children at 100 KB each land far under the parent's budget", () => {
		const results = fourBigChildren();
		const raw = aggregateParallelOutputs(results).length;
		const digested = digestParallelOutputs(results);

		assert.ok(raw > 400_000, `the unbounded form should be huge, was ${raw}`);
		// The plan's criterion is ~10 KB; the bound delivers far better than that.
		assert.ok(digested.length < 10_000, `digest was ${digested.length} chars`);
	});

	test("every task is still reachable — each line points at its full output", () => {
		const digested = digestParallelOutputs(fourBigChildren());
		// Four 100 KB children fit the default budget as two verbatim plus two
		// headlines, so nothing collapses and every one keeps its pointer.
		for (const agent of ["alpha", "bravo", "charlie", "delta"]) {
			assert.ok(
				digested.includes(`→ full output: /artifacts/${agent}.md`),
				`${agent} lost the path to its full output`,
			);
		}
		assert.ok(!digested.includes("collapsed"), "nothing should collapse at this size");
	});

	test("when tasks do collapse, the marker says where the rest went", () => {
		// Enough children that the budget cannot even headline them all.
		const many = Array.from({ length: 60 }, (_, i) =>
			task({
				agent: `agent${i}`,
				taskIndex: i,
				output: "x".repeat(5_000),
				artifactOutputPath: `/artifacts/agent${i}.md`,
			}),
		);
		const digested = digestParallelOutputs(many);
		assert.match(digested, /collapsed — read the artifact files above/);
		// The marker is honest about the count, not a vague "some".
		const stated = Number(/\((\d+) more task outputs? collapsed/.exec(digested)?.[1]);
		assert.ok(stated > 0 && stated < many.length, `marker claimed ${stated} of ${many.length}`);
	});

	test("a failure is never the thing that gets collapsed", () => {
		// The failure is last by task order, so only the ordering rule saves it.
		const results = [
			task({ agent: "alpha", taskIndex: 0, output: "a".repeat(100_000) }),
			task({ agent: "bravo", taskIndex: 1, output: "b".repeat(100_000) }),
			task({ agent: "charlie", taskIndex: 2, output: "c".repeat(100_000) }),
			task({ agent: "doomed", taskIndex: 3, output: "d".repeat(100_000), status: "error", error: "it broke" }),
		];
		const digested = digestParallelOutputs(results);

		assert.ok(digested.includes("doomed"), "the failing task vanished from the digest");
		assert.ok(digested.includes("it broke"), "the failure reason vanished from the digest");
		// And it leads, because that is where a reader looks first.
		const firstTaskLine = digested.split("\n").find((l) => l.startsWith("=== Task") || l.startsWith("· Task"));
		assert.match(String(firstTaskLine), /doomed/);
	});

	test("the bound holds no matter how many children or how loud they are", () => {
		for (const [count, size] of [
			[1, 10],
			[4, 100_000],
			[50, 20_000],
		] as const) {
			const results = Array.from({ length: count }, (_, i) =>
				task({ agent: `agent${i}`, taskIndex: i, output: "x".repeat(size) }),
			);
			const digested = digestParallelOutputs(results);
			assert.ok(digested.length < 10_000, `${count}×${size} rendered ${digested.length} chars`);
		}
	});

	test("inline aggregation is unchanged, so the opt-out still means what it meant", () => {
		const results = [
			task({ agent: "alpha", taskIndex: 0, output: "hello" }),
			task({ agent: "bravo", taskIndex: 1, output: "world", status: "error", error: "nope" }),
		];
		const inline = aggregateParallelOutputs(results, (i, agent) => `=== Task ${i + 1}: ${agent} ===`);
		assert.ok(inline.includes("hello"));
		assert.ok(inline.includes("FAILED: nope"));
		// Untouched by the ordering rule: inline keeps the caller's sequence.
		assert.ok(inline.indexOf("alpha") < inline.indexOf("bravo"));
	});

	test("small outputs survive whole, so the bound costs nothing when it is not needed", () => {
		const results = [
			task({ agent: "alpha", taskIndex: 0, output: "the answer is 42" }),
			task({ agent: "bravo", taskIndex: 1, output: "confirmed" }),
		];
		const digested = digestParallelOutputs(results);
		assert.ok(digested.includes("the answer is 42"));
		assert.ok(digested.includes("confirmed"));
		assert.ok(!digested.includes("collapsed"));
	});
});
