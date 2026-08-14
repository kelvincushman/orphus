import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type BoundedRenderFormat, boundedRender, capText } from "../../packages/roundtable/bounded-render.js";

interface Item {
	name: string;
	body: string;
}

/** A deliberately plain format, so assertions are about the tiering, not the prose. */
const format: BoundedRenderFormat<Item> = {
	text: (item) => item.body,
	verbatim: (item, capped, truncated) => `${item.name}: ${capped}${truncated > 0 ? ` +${truncated}` : ""}`,
	headline: (item, capped, hasMore) => `· ${item.name}: ${capped}${hasMore ? " …" : ""}`,
	collapsed: (count) => `(${count} collapsed)`,
};

function items(count: number, bodyLength: number): Item[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `item${i}`,
		body: "x".repeat(bodyLength),
	}));
}

/** Budget plus at most one marker line — the guarantee, expressed once. */
function assertWithinBound(text: string, budget: number, markerMax = 120): void {
	assert.ok(
		text.length <= budget + markerMax,
		`rendered ${text.length} chars against a budget of ${budget} (+${markerMax} marker allowance)`,
	);
}

describe("boundedRender", () => {
	test("the bound holds however much the items contain", () => {
		const budget = 500;
		// Two orders of magnitude of input, one budget.
		for (const [count, size] of [
			[1, 10],
			[5, 200],
			[50, 2_000],
			[500, 10_000],
		] as const) {
			const result = boundedRender(items(count, size), { budget, format });
			assertWithinBound(result.text, budget);
			assert.equal(result.total, count);
		}
	});

	test("a single hostile item cannot inflate what the reader pays", () => {
		const budget = 400;
		const result = boundedRender([{ name: "hostile", body: "y".repeat(5_000_000) }], { budget, format });
		assertWithinBound(result.text, budget);
		// It still appears — bounded, not discarded.
		assert.ok(result.text.includes("hostile"));
	});

	test("every item is accounted for in exactly one tier", () => {
		const result = boundedRender(items(40, 300), { budget: 600, format });
		assert.equal(result.verbatim + result.headlines + result.collapsed, result.total);
		assert.ok(result.collapsed > 0, "40 items of 300 chars cannot all fit in 600");
	});

	test("the collapse marker states how many it stands for", () => {
		const result = boundedRender(items(30, 400), { budget: 500, format });
		assert.match(result.text, /\(\d+ collapsed\)/);
		const stated = Number(/\((\d+) collapsed\)/.exec(result.text)?.[1]);
		assert.equal(stated, result.collapsed);
	});

	test("budget is spent in priority order — the first item survives verbatim", () => {
		const result = boundedRender(
			[
				{ name: "first", body: "a".repeat(100) },
				{ name: "second", body: "b".repeat(100) },
				{ name: "third", body: "c".repeat(100) },
			],
			{ budget: 250, preserveOrder: true, format },
		);
		// "first" got the budget; something later degraded or collapsed.
		assert.ok(result.text.includes("first: aaa"));
		assert.ok(result.verbatim >= 1);
		assert.ok(result.verbatim < 3, "a 250-char budget cannot hold three 100-char items verbatim");
	});

	test("preserveOrder controls output order without changing what is spent", () => {
		const three = [
			{ name: "one", body: "1" },
			{ name: "two", body: "2" },
			{ name: "three", body: "3" },
		];
		const reversed = boundedRender(three, { budget: 2000, format });
		const asGiven = boundedRender(three, { budget: 2000, preserveOrder: true, format });

		assert.equal(reversed.verbatim, asGiven.verbatim);
		assert.deepEqual(reversed.text.split("\n").reverse(), asGiven.text.split("\n"));
	});

	test("an empty list renders to nothing rather than a marker", () => {
		const result = boundedRender([], { budget: 500, format });
		assert.equal(result.text, "");
		assert.equal(result.total, 0);
		assert.equal(result.collapsed, 0);
	});

	test("budget floors stop a caller from disabling the tiering", () => {
		// Asking for a 1-char budget still renders something readable rather than
		// degenerating; the floor is what keeps the marker meaningful.
		const result = boundedRender(items(10, 500), { budget: 1, format });
		assert.ok(result.text.length > 0);
		assertWithinBound(result.text, 200);
	});

	test("capText trims trailing whitespace before measuring", () => {
		assert.deepEqual(capText("abc   ", 10), { text: "abc", truncated: 0 });
		assert.deepEqual(capText("abcdef", 3), { text: "abc", truncated: 3 });
	});
});
