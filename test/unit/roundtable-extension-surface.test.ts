import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RoundtableClient } from "../../packages/roundtable/broker/client.ts";
import { MAX_DIGEST_BUDGET } from "../../packages/roundtable/digest.ts";
import roundtableExtension from "../../packages/roundtable/index.ts";
import { MAX_REPLAY_CHARS, registerRoundtableTool } from "../../packages/roundtable/roundtable-tool.ts";
import type { RoomMessage } from "../../packages/roundtable/types.ts";
import { moduleDir, readText } from "../helpers/runtime.ts";

describe("roundtable extension surface", () => {
	it("exports an extension entry point and tool registrar", () => {
		expect(typeof roundtableExtension).toBe("function");
		expect(typeof registerRoundtableTool).toBe("function");
	});

	it("packages the raw memory implementation used by memory-tool.ts", async () => {
		const packageJson = JSON.parse(
			await readText(join(moduleDir(import.meta.url), "../../packages/roundtable/package.json")),
		) as { files: string[] };
		expect(packageJson.files).toContain("memory/**/*.ts");
	});

	it("replays collapsed digest history by sequence without moving the cursor", async () => {
		const messages: RoomMessage[] = Array.from({ length: 100 }, (_, index) => ({
			id: `id-${index + 1}`,
			seq: index + 1,
			timestamp: Date.UTC(2026, 0, 1, 0, index),
			room: "design",
			from: { sessionId: "planner-session", name: "planner" },
			text: `message ${index + 1}: ${"x".repeat(200)}`,
		}));
		let cursor = 0;
		const fetch = vi.fn(async (_room: string, afterSeq: number, limit = 200) => ({
			messages: messages.filter((message) => message.seq > afterSeq).slice(0, limit),
			lastSeq: messages.length,
			cursor,
		}));
		const setCursor = vi.fn(async (_room: string, seq: number) => {
			cursor = seq;
			return cursor;
		});
		const client = { fetch, setCursor } as unknown as RoundtableClient;
		let execute:
			| ((...args: unknown[]) => Promise<{ isError: boolean; content: Array<{ text: string }> }>)
			| undefined;
		const pi = {
			registerTool: (definition: { execute: typeof execute }) => {
				execute = definition.execute;
			},
		} as unknown as Parameters<typeof registerRoundtableTool>[0];
		registerRoundtableTool(pi, { ensureConnected: async () => client });
		if (!execute) throw new Error("roundtable tool was not registered");

		const longRoom = "r".repeat(128);
		const digest = await execute(
			"digest",
			{ action: "digest", room: longRoom, budget: 200 },
			undefined,
			undefined,
			undefined,
		);
		const digestText = digest.content[0]?.text ?? "";
		expect(digestText).toMatch(/collapsed/);
		expect(digestText.length).toBeLessThanOrEqual(200);
		expect(setCursor).toHaveBeenCalledWith(longRoom, 100);

		const maxDigest = await execute(
			"peek",
			{ action: "peek", room: longRoom, budget: MAX_DIGEST_BUDGET * 10 },
			undefined,
			undefined,
			undefined,
		);
		expect(maxDigest.content[0]?.text.length).toBeLessThanOrEqual(MAX_DIGEST_BUDGET);

		const replay = await execute(
			"replay",
			{ action: "replay", room: "design", afterSeq: 0, limit: 2 },
			undefined,
			undefined,
			undefined,
		);
		expect(replay.isError).toBe(false);
		expect(replay.content[0]?.text).toContain("message 1");
		expect(replay.content[0]?.text).toContain("message 2");
		expect(setCursor).toHaveBeenCalledTimes(1);
	});

	it("keeps hostile replay history bounded and paginates by complete messages", async () => {
		const messages: RoomMessage[] = Array.from({ length: 100 }, (_, index) => ({
			id: `id-${index + 1}`,
			seq: index + 1,
			timestamp: Date.UTC(2026, 0, 1, 0, index),
			room: "design",
			from: { sessionId: "verbose-session", name: "verbose" },
			text: `message ${index + 1}: ${"x".repeat(4000)}`,
		}));
		const fetch = vi.fn(async (_room: string, afterSeq: number, limit = 200) => ({
			messages: messages.filter((message) => message.seq > afterSeq).slice(0, limit),
			lastSeq: messages.length,
			cursor: 0,
		}));
		const setCursor = vi.fn();
		const client = { fetch, setCursor } as unknown as RoundtableClient;
		let execute:
			| ((...args: unknown[]) => Promise<{ isError: boolean; content: Array<{ text: string }>; details?: unknown }>)
			| undefined;
		const pi = {
			registerTool: (definition: { execute: typeof execute }) => {
				execute = definition.execute;
			},
		} as unknown as Parameters<typeof registerRoundtableTool>[0];
		registerRoundtableTool(pi, { ensureConnected: async () => client });
		if (!execute) throw new Error("roundtable tool was not registered");

		const first = await execute(
			"replay",
			{ action: "replay", room: "design", afterSeq: 0, limit: 100 },
			undefined,
			undefined,
			undefined,
		);
		expect(first.content[0]?.text.length).toBeLessThanOrEqual(MAX_REPLAY_CHARS);
		expect(first.content[0]?.text).toContain("message 1");
		expect(first.content[0]?.text).not.toContain("message 2");
		expect(first.details).toMatchObject({ lastReturnedSeq: 1, hasMore: true, messages: 1 });

		const second = await execute(
			"replay",
			{ action: "replay", room: "design", afterSeq: 1, limit: 100 },
			undefined,
			undefined,
			undefined,
		);
		expect(second.content[0]?.text.length).toBeLessThanOrEqual(MAX_REPLAY_CHARS);
		expect(second.content[0]?.text).toContain("message 2");
		expect(setCursor).not.toHaveBeenCalled();
	});
});
