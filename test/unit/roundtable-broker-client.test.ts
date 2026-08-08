import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoundtableBroker } from "../../packages/roundtable/broker/broker.js";
import { RoundtableClient } from "../../packages/roundtable/broker/client.js";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../../packages/roundtable/broker/paths.js";
import { createRoundtableTool, type RoundtableToolParams } from "../../packages/roundtable/roundtable-tool.js";
import { fileExists, readText } from "../helpers/runtime.js";

type ExportToolParams = Omit<RoundtableToolParams, "action"> & { action: "export" };

function captureRoundtableTool(client: RoundtableClient, exportRoot: string, role: string | undefined) {
	const ensureConnected = vi.fn(async () => client);
	const tool = createRoundtableTool({
		ensureConnected,
		exportRoot,
		currentRole: () => role,
		writerRole: "librarian",
	});
	const run = (params: ExportToolParams) => tool.execute("call-1", params, undefined, undefined, undefined as never);
	return { ensureConnected, run };
}

describe("roundtable broker and client over a real socket", () => {
	let agentDir: string;
	let broker: RoundtableBroker;
	let socketPath: string;
	const clients: RoundtableClient[] = [];

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "roundtable-test-"));
		socketPath = getBrokerSocketPath(process.platform, agentDir);
		broker = new RoundtableBroker(socketPath, getBrokerPidPath(agentDir), getRoundtableDirPath(agentDir));
		await new Promise<void>((resolve) => broker.start(resolve));
	});

	afterEach(() => {
		for (const client of clients.splice(0)) client.disconnect();
		broker.shutdown();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function connect(name: string): Promise<RoundtableClient> {
		const client = new RoundtableClient(name, socketPath);
		await client.connect();
		clients.push(client);
		return client;
	}

	it("registers, joins, posts, and fetches across two clients", async () => {
		const planner = await connect("planner");
		const critic = await connect("critic");

		await planner.join("design", "rate limiter");
		await critic.join("design");

		const posted = await planner.post("design", "Proposal: GCRA locally");
		expect(posted.seq).toBe(1);

		const { messages, lastSeq } = await critic.fetch("design", 0);
		expect(lastSeq).toBe(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe("Proposal: GCRA locally");
		expect(messages[0]?.from.name).toBe("planner");
	});

	it("pushes tiny activity events to other members only", async () => {
		const planner = await connect("planner");
		const critic = await connect("critic");
		await planner.join("design");
		await critic.join("design");

		const criticEvents: Array<{ room: string; from: string; seq: number }> = [];
		const plannerEvents: Array<{ room: string; from: string; seq: number }> = [];
		critic.onActivity((event) => criticEvents.push(event));
		planner.onActivity((event) => plannerEvents.push(event));

		await planner.post("design", "hello");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(criticEvents.some((e) => e.room === "design" && e.from === "planner" && e.seq === 1)).toBe(true);
		expect(plannerEvents.filter((e) => e.seq === 1)).toHaveLength(0);
	});

	it("persists read cursors across reconnects by member name", async () => {
		const planner = await connect("planner");
		await planner.join("design");
		await planner.post("design", "one");
		await planner.post("design", "two");
		await planner.setCursor("design", 2);

		planner.disconnect();
		const reborn = await connect("planner");
		const { cursor } = await reborn.join("design");
		expect(cursor).toBe(2);
	});

	// The ingest path for memory: a digest collapses older messages, so memory must
	// be fed from the broker directly. Export must be lossless and leave cursors alone.
	it("exports the retained transcript without consuming unread state", async () => {
		const planner = await connect("planner");
		const librarian = await connect("librarian");
		await planner.join("design");
		await librarian.join("design");
		const posted = [];
		for (let i = 1; i <= 12; i++) posted.push(await planner.post("design", `message ${i}`));
		const exportRoot = join(agentDir, "memory");
		const { run } = captureRoundtableTool(librarian, exportRoot, "librarian");

		const missingPath = await run({ action: "export", room: "design" });
		assert.equal(missingPath.isError, true);
		const escapedPath = await run({ action: "export", room: "design", path: "../escape.md" });
		assert.equal(escapedPath.isError, true);
		const absolutePath = join(exportRoot, "raw", "absolute.md");
		const absolute = await run({ action: "export", room: "design", path: absolutePath });
		assert.equal(absolute.isError, true);
		assert.equal(await fileExists(absolutePath), false);
		const outsideRaw = await run({ action: "export", room: "design", path: "design.md" });
		assert.equal(outsideRaw.isError, true);
		assert.equal(await fileExists(join(exportRoot, "design.md")), false);

		const relativePath = "raw/nested/design.md";
		const target = join(exportRoot, relativePath);
		const result = await run({ action: "export", room: "design", path: relativePath });
		assert.equal(result.isError, false);
		assert.equal(result.details.path, target);
		assert.equal(result.details.messages, 12);
		assert.equal(result.details.firstSeq, 1);
		assert.equal(result.details.lastSeq, 12);
		assert.equal(result.details.truncated, false);
		assert.equal(
			await readText(target),
			`${posted.map((message) => `[${new Date(message.timestamp).toISOString()}] planner#${message.seq}: ${message.text}`).join("\n")}\n`,
		);

		// Exporting must leave the librarian's unread state untouched, so that role can
		// export a room at any time without stealing another role's catch-up.
		const after = await librarian.fetch("design", 0);
		assert.equal(after.cursor, 0);
		assert.equal(after.messages.length, 12);
		assert.equal(after.messages[0]?.text, "message 1");
		assert.equal(after.messages[11]?.text, "message 12");
	});

	it("blocks non-librarians before exporting a room into shared memory", async () => {
		const planner = await connect("planner");
		await planner.join("design");
		await planner.post("design", "do not export me");
		const exportRoot = join(agentDir, "memory");
		const target = join(exportRoot, "raw", "unauthorized.md");
		const { ensureConnected, run } = captureRoundtableTool(planner, exportRoot, "planner");

		const result = await run({ action: "export", room: "design", path: "raw/unauthorized.md" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Only the "librarian" role/);
		expect(ensureConnected).not.toHaveBeenCalled();
		assert.equal(await fileExists(target), false);
	});

	it.skipIf(process.platform === "win32")("rejects export paths through symlinks outside shared memory", async () => {
		const librarian = await connect("librarian");
		await librarian.join("design");
		await librarian.post("design", "do not escape");
		const exportRoot = join(agentDir, "memory");
		const outside = join(agentDir, "outside");
		mkdirSync(join(exportRoot, "raw"), { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(exportRoot, "raw", "escape"));
		const { run } = captureRoundtableTool(librarian, exportRoot, "librarian");

		const result = await run({ action: "export", room: "design", path: "raw/escape/transcript.md" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /symlink outside/);
		assert.equal(await fileExists(join(outside, "transcript.md")), false);
	});

	it("reports when an export starts after older messages rotated out", async () => {
		const librarian = await connect("librarian");
		await librarian.join("design");
		for (let i = 1; i <= 501; i++) await librarian.post("design", `message ${i}`);
		const exportRoot = join(agentDir, "memory");
		const { run } = captureRoundtableTool(librarian, exportRoot, "librarian");
		const target = join(exportRoot, "raw", "truncated.md");
		const result = await run({ action: "export", room: "design", path: "raw/truncated.md" });

		assert.equal(result.isError, false);
		assert.equal(result.details.messages, 500);
		assert.equal(result.details.firstSeq, 2);
		assert.equal(result.details.lastSeq, 501);
		assert.equal(result.details.droppedBefore, 1);
		assert.equal(result.details.truncated, true);
		assert.match(result.content[0]?.text ?? "", /1 older message/);
		assert.match((await readText(target)).split("\n")[0] ?? "", /librarian#2: message 2$/);
	});

	it("rejects posting to a room the session has not joined", async () => {
		const outsider = await connect("outsider");
		await expect(outsider.post("nowhere", "hi")).rejects.toThrow(/does not exist|join it first/);
	});
});

// The Windows named-pipe name derives from the agent dir. A lossy sanitizer
// would collide distinct dirs onto one machine-global pipe; the name must be
// unique per full path.
describe("windows broker pipe naming", () => {
	it("gives distinct agent dirs distinct pipe names despite punctuation/case", () => {
		const names = [
			"C:\\agents\\team.one",
			"C:\\agents\\team_one",
			"C:\\agents\\team-one",
			"C:\\agents\\Team.One",
		].map((d) => getBrokerSocketPath("win32", d));
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name.startsWith("\\\\.\\pipe\\atomic-roundtable-")).toBe(true);
	});

	it("is deterministic for the same agent dir", () => {
		expect(getBrokerSocketPath("win32", "C:\\agents\\x")).toBe(getBrokerSocketPath("win32", "C:\\agents\\x"));
	});
});

// A connect failure must not orphan the internal `registered` promise: an
// unhandled rejection exits the process under Node.
describe("client connect failure", () => {
	it("rejects cleanly with no unhandled rejection when the socket is dead", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const client = new RoundtableClient("x", join(tmpdir(), "roundtable-nonexistent.sock"));
			await expect(client.connect()).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 50)); // let any orphan rejection surface
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		expect(rejections).toEqual([]);
	});
});
