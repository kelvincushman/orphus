import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoundtableBroker } from "../../packages/roundtable/broker/broker.ts";
import { RoundtableClient } from "../../packages/roundtable/broker/client.ts";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../../packages/roundtable/broker/paths.ts";

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
	it("exports the full transcript losslessly without consuming unread state", async () => {
		const planner = await connect("planner");
		const critic = await connect("critic");
		await planner.join("design");
		await critic.join("design");
		for (let i = 1; i <= 12; i++) await planner.post("design", `message ${i}`);

		// The critic has read nothing. Exporting must return every message...
		const { messages, cursor } = await critic.fetch("design", 0);
		expect(messages).toHaveLength(12);
		expect(messages[0]?.text).toBe("message 1"); // the one a digest would collapse
		expect(messages[11]?.text).toBe("message 12");
		expect(cursor).toBe(0);

		// ...and must leave the critic's unread state untouched, so a librarian can
		// export a room at any time without stealing another role's catch-up.
		const after = await critic.fetch("design", 0);
		expect(after.cursor).toBe(0);
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
