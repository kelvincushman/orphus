import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type BoundedRenderFormat,
	boundedRender,
	capText,
	MAX_MARKER_CHARS,
} from "../../packages/roundtable/bounded-render.js";

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

/**
 * Budget plus the marker actually rendered — nothing more.
 *
 * A fixed allowance would let a renderer exceed the budget by that much even
 * when no marker exists, so the allowance is derived: the exact marker for this
 * result's collapsed count plus its newline, or zero when nothing collapsed.
 */
function assertWithinBound(result: { text: string; collapsed: number }, budget: number): void {
	const allowance = result.collapsed > 0 ? format.collapsed(result.collapsed).length + 1 : 0;
	assert.ok(
		result.text.length <= budget + allowance,
		`rendered ${result.text.length} chars against a budget of ${budget} + ${allowance} marker allowance`,
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
			assertWithinBound(result, budget);
			assert.equal(result.total, count);
		}
	});

	test("a single hostile item cannot inflate what the reader pays", () => {
		const budget = 400;
		const result = boundedRender([{ name: "hostile", body: "y".repeat(5_000_000) }], { budget, format });
		assertWithinBound(result, budget);
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

	test("preserveOrder changes only the output order, not tier selection", () => {
		// A budget tight enough that the tiers actually differ: with everything
		// fitting verbatim the comparison would hold no matter what the flag did.
		const budget = 400;
		const contested = [
			{ name: "alpha", body: "a".repeat(300) },
			{ name: "bravo", body: "b".repeat(300) },
			{ name: "charlie", body: "c".repeat(300) },
			{ name: "delta", body: "d".repeat(300) },
		];
		const reversed = boundedRender(contested, { budget, format });
		const asGiven = boundedRender(contested, { budget, preserveOrder: true, format });

		// The tiers are genuinely in play, so the comparison means something.
		assert.ok(reversed.verbatim > 0 && reversed.verbatim < contested.length);
		assert.ok(reversed.collapsed > 0 || reversed.headlines > 0);

		// Identical spending decisions...
		assert.equal(reversed.verbatim, asGiven.verbatim);
		assert.equal(reversed.headlines, asGiven.headlines);
		assert.equal(reversed.collapsed, asGiven.collapsed);

		// ...the same items chosen for each tier, by name...
		const namesIn = (text: string) => contested.map((i) => i.name).filter((n) => text.includes(n));
		assert.deepEqual(namesIn(reversed.text).sort(), namesIn(asGiven.text).sort());

		// ...and only the order in which they are printed differs. The marker
		// leads both, so compare the item lines beneath it.
		const bodyLines = (text: string) => text.split("\n").filter((l) => !l.startsWith("("));
		assert.deepEqual(bodyLines(reversed.text).reverse(), bodyLines(asGiven.text));
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
		assertWithinBound(result, 200);
	});

	test("a careless marker formatter cannot break the bound it announces", () => {
		// The marker comes from the caller, so the guarantee cannot depend on the
		// caller being careful. Both failure modes are contained: a marker that
		// runs to megabytes, and one that smuggles in extra lines.
		const budget = 300;
		const runaway = boundedRender(items(30, 400), {
			budget,
			format: { ...format, collapsed: (count) => "x".repeat(count * 10_000) },
		});
		assert.ok(
			runaway.text.length <= budget + MAX_MARKER_CHARS + 1,
			`a runaway marker escaped the bound: ${runaway.text.length} chars`,
		);

		const multiline = boundedRender(items(30, 400), {
			budget,
			format: { ...format, collapsed: (count) => `line one\nline two\n${count} more` },
		});
		const markerLine = multiline.text.split("\n")[0] ?? "";
		assert.ok(!markerLine.includes("\n"));
		assert.equal(multiline.text.split("\n").length, multiline.verbatim + multiline.headlines + 1);
	});

	test("capText trims trailing whitespace before measuring", () => {
		assert.deepEqual(capText("abc   ", 10), { text: "abc", truncated: 0 });
		assert.deepEqual(capText("abcdef", 3), { text: "abc", truncated: 3 });
	});
});
