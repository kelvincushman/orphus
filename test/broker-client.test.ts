import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoundtableBroker } from "../src/broker/broker.ts";
import { RoundtableClient } from "../src/broker/client.ts";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../src/broker/paths.ts";

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

	it("rejects posting to a room the session has not joined", async () => {
		const outsider = await connect("outsider");
		await expect(outsider.post("nowhere", "hi")).rejects.toThrow(/does not exist|join it first/);
	});
});
