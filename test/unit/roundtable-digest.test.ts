import { describe, expect, it } from "vitest";
import { buildDigest, MAX_DIGEST_BUDGET } from "../../packages/roundtable/digest.ts";
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

	it("renders timestamps in UTC", () => {
		const atUtc = { ...message(1, "utc"), timestamp: Date.UTC(2026, 0, 2, 3, 4) };
		expect(buildDigest([atUtc]).text).toContain("[03:04]");
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

	it("collapses older messages at the minimum digest budget", () => {
		const messages = Array.from({ length: 30 }, (_, i) => message(i + 1, `msg ${i}: ${"z".repeat(200)}`));
		const digest = buildDigest(messages, { budget: 200 });
		expect(digest.collapsed).toBeGreaterThan(0);
		expect(digest.text).toMatch(/collapsed/);
	});

	it("clamps finite budgets and falls back for non-finite values", () => {
		const messages = Array.from({ length: 50 }, (_, i) => message(i + 1, "x".repeat(500)));
		const clamped = buildDigest(messages, { budget: MAX_DIGEST_BUDGET * 10 });
		expect(clamped.chars).toBeLessThanOrEqual(MAX_DIGEST_BUDGET + 120);
		const fallback = buildDigest(messages, { budget: Number.POSITIVE_INFINITY });
		expect(fallback.chars).toBeLessThanOrEqual(2000 + 120);
	});
});
