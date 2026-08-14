import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { ContextAccounting, formatChars } from "../../packages/coding-agent/src/core/context-accounting.js";
import {
	collectText,
	redirectOversizedToolResult,
} from "../../packages/coding-agent/src/core/tools/oversized-tool-result.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("context accounting", () => {
	test("sums per tool and across the session", () => {
		const accounting = new ContextAccounting();
		accounting.record({ toolName: "read", chars: 100, originalChars: 100, spilled: false });
		accounting.record({ toolName: "read", chars: 50, originalChars: 50, spilled: false });
		accounting.record({ toolName: "bash", chars: 700, originalChars: 700, spilled: false });

		assert.deepEqual(accounting.totals(), { calls: 3, chars: 850, originalChars: 850, spilled: 0 });
		assert.deepEqual(accounting.byTool().get("read"), {
			calls: 2,
			chars: 150,
			originalChars: 150,
			spilled: 0,
		});
	});

	test("orders tools by context cost, not call count", () => {
		const accounting = new ContextAccounting();
		for (let i = 0; i < 10; i++) {
			accounting.record({ toolName: "read", chars: 10, originalChars: 10, spilled: false });
		}
		accounting.record({ toolName: "bash", chars: 5000, originalChars: 5000, spilled: false });

		// `read` ran ten times; `bash` once. The expensive one leads.
		assert.deepEqual([...accounting.byTool().keys()], ["bash", "read"]);
	});

	test("a spilled result is counted at what entered context, not what it held", () => {
		const accounting = new ContextAccounting();
		accounting.record({ toolName: "bash", chars: 2_000, originalChars: 400_000, spilled: true });

		const totals = accounting.totals();
		assert.equal(totals.chars, 2_000, "context cost is the reference, not the payload");
		assert.equal(totals.originalChars, 400_000);
		assert.equal(totals.spilled, 1);
		assert.match(accounting.summary(), /spilled to disk/);
	});

	test("summary is empty before any tool runs, so callers need no emptiness check", () => {
		assert.equal(new ContextAccounting().summary(), "");
	});

	test("summary names the heaviest contributors and pluralises honestly", () => {
		const accounting = new ContextAccounting();
		accounting.record({ toolName: "bash", chars: 1, originalChars: 1, spilled: false });
		assert.match(accounting.summary(), /over 1 call \(/);

		accounting.record({ toolName: "bash", chars: 1, originalChars: 1, spilled: false });
		assert.match(accounting.summary(), /over 2 calls \(/);
	});

	test("character counts stay compact across magnitudes", () => {
		assert.equal(formatChars(0), "0");
		assert.equal(formatChars(999), "999");
		assert.equal(formatChars(1000), "1.0k");
		assert.equal(formatChars(50_000), "50.0k");
		assert.equal(formatChars(1_000_000), "1.0M");
	});

	test("rounding never carries past the unit into a four-digit k", () => {
		// 999_950 rounds up to 1000.0k, which is longer than the number it
		// abbreviates. The boundary belongs to M.
		assert.equal(formatChars(999_949), "999.9k");
		assert.equal(formatChars(999_950), "1.0M");
		assert.equal(formatChars(999_999), "1.0M");
	});
});

describe("context accounting agrees with the spill it describes", () => {
	test("an oversized result records the reference length, not the payload length", async () => {
		const sessionDir = tempDir("orphus-context-accounting-");
		const payload = "x".repeat(120_000);
		const result = { content: [{ type: "text" as const, text: payload }], details: undefined };

		const replacement = await redirectOversizedToolResult({
			toolName: "bash",
			toolCallId: "call-1",
			result,
			isError: false,
			sessionId: "session-1",
			sessionDir,
		});

		assert.ok(replacement, "a 120k result must exceed the 50k persistence threshold");

		// Exactly the arithmetic the afterToolCall hook performs.
		const originalChars = collectText(result.content).length;
		const chars = collectText(replacement.content).length;

		const accounting = new ContextAccounting();
		accounting.record({ toolName: "bash", chars, originalChars, spilled: true });

		const totals = accounting.totals();
		assert.equal(totals.originalChars, 120_000);
		assert.ok(
			totals.chars < 10_000,
			`a spilled result should enter context as a small reference, got ${totals.chars}`,
		);
		assert.ok(
			totals.originalChars - totals.chars > 100_000,
			"the accounting must show the saving the spill actually made",
		);
	});

	test("a result under the threshold enters whole and is not counted as spilled", async () => {
		const sessionDir = tempDir("orphus-context-accounting-");
		const payload = "y".repeat(1_000);
		const result = { content: [{ type: "text" as const, text: payload }], details: undefined };

		const replacement = await redirectOversizedToolResult({
			toolName: "read",
			toolCallId: "call-2",
			result,
			isError: false,
			sessionId: "session-1",
			sessionDir,
		});

		assert.equal(replacement, undefined, "a 1k result is well under the threshold");

		const accounting = new ContextAccounting();
		accounting.record({
			toolName: "read",
			chars: collectText(result.content).length,
			originalChars: collectText(result.content).length,
			spilled: replacement !== undefined,
		});

		assert.deepEqual(accounting.totals(), {
			calls: 1,
			chars: 1_000,
			originalChars: 1_000,
			spilled: 0,
		});
		assert.doesNotMatch(accounting.summary(), /spilled to disk/);
	});
});
