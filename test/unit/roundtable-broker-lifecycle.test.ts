import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoundtableBroker } from "../../packages/roundtable/broker/broker.js";
import { RoundtableClient } from "../../packages/roundtable/broker/client.js";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../../packages/roundtable/broker/paths.js";
import { canConnect } from "../../packages/roundtable/broker/socket-probe.js";
import { sleep } from "../helpers/runtime.js";

// Short enough that a test asserts on the idle timer firing rather than on a
// wall-clock wait, long enough that a loaded runner still completes the socket
// work in between. Every wait below is derived from it rather than restated.
const IDLE_GRACE_MS = 150;

// Activity events are pushed, so a notification triggered by an awaited call can
// still be in flight when that call resolves. Long enough to drain a local
// socket, short enough not to pad the suite.
const NOTIFICATION_DRAIN_MS = 100;

function makeBroker(agentDir: string, options: { exitWhenIdle?: boolean } = {}): RoundtableBroker {
	return new RoundtableBroker(
		getBrokerSocketPath(process.platform, agentDir),
		getBrokerPidPath(agentDir),
		getRoundtableDirPath(agentDir),
		{ idleGraceMs: IDLE_GRACE_MS, ...options },
	);
}

describe("roundtable broker lifecycle", () => {
	let agentDir: string;
	let socketPath: string;
	const started: RoundtableBroker[] = [];
	const clients: RoundtableClient[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "roundtable-lifecycle-"));
		socketPath = getBrokerSocketPath(process.platform, agentDir);
	});

	afterEach(() => {
		for (const client of clients.splice(0)) client.disconnect();
		for (const broker of started.splice(0)) broker.shutdown();
		vi.restoreAllMocks();
		rmSync(agentDir, { recursive: true, force: true });
	});

	function start(broker: RoundtableBroker): Promise<void> {
		started.push(broker);
		return new Promise<void>((resolve, reject) => {
			broker.start(resolve, reject);
		});
	}

	async function connect(name: string): Promise<RoundtableClient> {
		const client = new RoundtableClient(name, socketPath);
		await client.connect();
		clients.push(client);
		return client;
	}

	// The failure this prevents is silent: the pending idle check fires after
	// shutdown() has already cleared the session map, so its emptiness test
	// passes and it exits the process with code 0. Under vitest that kills the
	// worker mid-suite and reads as a clean run.
	it("does not exit the process when an armed idle check outlives shutdown()", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const broker = makeBroker(agentDir, { exitWhenIdle: true });
		await start(broker);

		const client = await connect("planner");
		client.disconnect(); // arms the idle check via the server's close handler
		await sleep(IDLE_GRACE_MS / 3);

		broker.shutdown();
		await sleep(IDLE_GRACE_MS * 3);

		assert.equal(exit.mock.calls.length, 0);
	});

	// The same timer must still do its job for the broker that owns its process.
	it("exits when genuinely idle, but only when it owns the process", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

		const embedded = makeBroker(agentDir);
		await start(embedded);
		const first = await connect("planner");
		first.disconnect();
		await sleep(IDLE_GRACE_MS * 3);
		assert.equal(exit.mock.calls.length, 0, "an embedded broker must never exit its host");
		embedded.shutdown();

		const owner = makeBroker(agentDir, { exitWhenIdle: true });
		await start(owner);
		const second = await connect("critic");
		second.disconnect();
		await sleep(IDLE_GRACE_MS * 3);
		assert.deepEqual(exit.mock.calls[0], [0]);
	});

	// `orphus-roles --format tmux | sh` starts several sessions at once and each
	// calls ensureBrokerRunning, so all but the first lose this race. The loser
	// used to unlink the winner's socket and listen on its own store, splitting
	// the fleet across two brokers that could not see each other.
	it("leaves the winner's socket alone when another broker already owns the path", async () => {
		const winner = makeBroker(agentDir);
		await start(winner);

		const planner = await connect("planner");
		await planner.join("design", "rate limiter");
		await planner.post("design", "GCRA locally");

		const loser = makeBroker(agentDir);
		started.push(loser);
		const lost = await new Promise<Error>((resolve, reject) => {
			loser.start(() => reject(new Error("the second broker bound a socket the first one owns")), resolve);
		});
		expect(lost.message).toContain("Another roundtable broker is already listening");
		loser.shutdown();
		assert.equal(existsSync(getBrokerPidPath(agentDir)), true);
		assert.equal(readFileSync(getBrokerPidPath(agentDir), "utf8"), String(process.pid));

		// The decisive assertion: a client connecting now must reach the winner,
		// with the room history intact. A split broker answers with an empty store.
		const critic = await connect("critic");
		const rooms = await critic.listRooms();
		assert.deepEqual(
			rooms.map((room) => room.name),
			["design"],
		);
		const { messages } = await critic.fetch("design", 0);
		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.text, "GCRA locally");
	});

	it("serializes simultaneous stale-socket recovery and leaves exactly one broker reachable", async () => {
		mkdirSync(getRoundtableDirPath(agentDir), { recursive: true });
		writeFileSync(socketPath, "not a live socket");
		const contenders = Array.from({ length: 6 }, () => makeBroker(agentDir));
		started.push(...contenders);

		const outcomes = await Promise.all(
			contenders.map(
				(broker) =>
					new Promise<"started" | "lost">((resolve) => {
						broker.start(
							() => resolve("started"),
							() => resolve("lost"),
						);
					}),
			),
		);

		assert.equal(outcomes.filter((outcome) => outcome === "started").length, 1);
		assert.equal(await canConnect(socketPath), true);
	});

	// The other half of the same decision: refusing to unlink must not strand the
	// fleet behind a socket entry that a SIGKILLed broker left behind.
	it("reclaims a socket path that nothing is serving", async () => {
		mkdirSync(getRoundtableDirPath(agentDir), { recursive: true });
		writeFileSync(socketPath, "not a live socket");

		const broker = makeBroker(agentDir);
		await start(broker);

		const planner = await connect("planner");
		await planner.join("design");
		assert.equal((await planner.listRooms()).length, 1);
	});

	it("probes a live socket as reachable and an unused path as not", async () => {
		assert.equal(await canConnect(socketPath), false);
		const broker = makeBroker(agentDir);
		await start(broker);
		assert.equal(await canConnect(socketPath), true);
	});
});

describe("roundtable broker membership notifications", () => {
	let agentDir: string;
	let socketPath: string;
	let broker: RoundtableBroker;
	const clients: RoundtableClient[] = [];

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "roundtable-membership-"));
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

	// A join carried the room's lastSeq, and the extension treats any non-zero
	// seq as content, so joining a room with history pinged every peer about a
	// message that does not exist. The late joiner — the case the whole digest
	// tier exists to serve — always has history, so this fired every time.
	it("announces a join into a room with history as membership, not as content", async () => {
		const planner = await connect("planner");
		await planner.join("design");
		await planner.post("design", "one");
		await planner.post("design", "two");

		const events: Array<{ room: string; from: string; seq: number }> = [];
		planner.onActivity((event) => events.push({ room: event.room, from: event.from, seq: event.seq }));

		const reviewer = await connect("reviewer");
		await reviewer.join("design");
		await sleep(NOTIFICATION_DRAIN_MS);

		// seq 0 is what the extension filters as membership churn. Any other value
		// is claimed content, and this room's newest message is seq 2.
		assert.deepEqual(events, [{ room: "design", from: "reviewer", seq: 0 }]);
	});

	// Departures were announced when a session died but not when it left cleanly.
	it("announces a clean leave the same way it announces a dropped session", async () => {
		const planner = await connect("planner");
		const critic = await connect("critic");
		await planner.join("design");
		await critic.join("design");
		// critic's own join notifies planner; let that land before recording, so
		// the assertion is about the leave and not about arrival ordering.
		await sleep(NOTIFICATION_DRAIN_MS);

		const events: Array<{ room: string; from: string; seq: number }> = [];
		planner.onActivity((event) => events.push({ room: event.room, from: event.from, seq: event.seq }));

		await critic.leave("design");
		await sleep(NOTIFICATION_DRAIN_MS);

		assert.deepEqual(events, [{ room: "design", from: "(left)", seq: 0 }]);
	});
});
