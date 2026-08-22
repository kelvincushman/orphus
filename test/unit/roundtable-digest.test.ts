import { describe, expect, it } from "vitest";
import { buildDigest } from "../../packages/roundtable/digest.ts";
import type { RoomMessage } from "../../packages/roundtable/types.ts";

function message(seq: number, text: string, name = "agent"): RoomMessage {
	return {
		id: `id-${seq}`,
		seq,
		timestamp: 1_700_000_000_000 + seq * 1000,
		room: "design",
		from: { sessionId: `session-${name}`, name },
		text,
	};
}

describe("roundtable digest", () => {
	it("returns an empty digest for no messages", () => {
		const digest = buildDigest([]);
		expect(digest.total).toBe(0);
		expect(digest.consumedSeq).toBe(0);
		expect(digest.text).toBe("No new messages.");
	});

	it("shows few short messages verbatim", () => {
		const digest = buildDigest([message(1, "hello"), message(2, "world")]);
		expect(digest.verbatim).toBe(2);
		expect(digest.headlines).toBe(0);
		expect(digest.collapsed).toBe(0);
		expect(digest.consumedSeq).toBe(2);
		expect(digest.text).toContain("hello");
		expect(digest.text).toContain("world");
	});

	it("renders chronologically but budgets newest-first", () => {
		const messages = [
			message(1, "oldest message that is fairly long ".repeat(20)),
			message(2, "middle message"),
			message(3, "newest message"),
		];
		const digest = buildDigest(messages, { budget: 300 });
		const newestIndex = digest.text.indexOf("newest message");
		expect(newestIndex).toBeGreaterThan(-1);
		// Newest survives verbatim; the long oldest is demoted or collapsed.
		expect(digest.verbatim).toBeGreaterThanOrEqual(1);
		expect(digest.total).toBe(3);
		const middleIndex = digest.text.indexOf("middle message");
		if (middleIndex !== -1) expect(middleIndex).toBeLessThan(newestIndex);
	});

	it("never exceeds budget plus one collapse marker line", () => {
		const messages = Array.from({ length: 60 }, (_, i) => message(i + 1, `message ${i + 1}: ${"x".repeat(400)}`));
		const budget = 1500;
		const digest = buildDigest(messages, { budget });
		// Collapse marker line is the only allowance beyond the budget.
		const markerAllowance = 120;
		expect(digest.chars).toBeLessThanOrEqual(budget + markerAllowance);
		expect(digest.collapsed).toBeGreaterThan(0);
		expect(digest.consumedSeq).toBe(60);
	});

	it("caps oversized single messages with a truncation marker", () => {
		const digest = buildDigest([message(1, "y".repeat(5000))], { budget: 2000, perMessageCap: 300 });
		expect(digest.chars).toBeLessThanOrEqual(2000);
		expect(digest.text).toContain("chars)");
	});

	it("the collapse marker's advice actually works after the cursor advances", () => {
		// The digest marks everything consumed, collapsed included, so "raise
		// budget and re-digest" was a dead end — the next digest starts after
		// these messages and reports nothing. The marker now names the one
		// recovery that works: a fetch from just before the oldest collapsed seq.
		const many = Array.from({ length: 12 }, (_, i) => message(i + 5, `message number ${i} ${"padding ".repeat(30)}`));
		const digest = buildDigest(many, { budget: 300 });
		expect(digest.collapsed).toBeGreaterThan(0);
		expect(digest.text).toContain("fetch with after_seq 4");
		expect(digest.text).not.toContain("raise budget");
	});

	it("collapses everything to a count line under a tiny budget", () => {
		const messages = Array.from({ length: 30 }, (_, i) => message(i + 1, `msg ${i}: ${"z".repeat(200)}`));
		const digest = buildDigest(messages, { budget: 200 });
		expect(digest.collapsed).toBeGreaterThan(0);
		expect(digest.text).toMatch(/collapsed/);
	});
});
