import assert from "node:assert/strict";
import type { ExtensionAPI } from "@orphus/coding-agent";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoundtableBroker } from "../../packages/roundtable/broker/broker.js";
import { RoundtableClient } from "../../packages/roundtable/broker/client.js";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../../packages/roundtable/broker/paths.js";
import roundtableExtension from "../../packages/roundtable/index.js";
import { sleep } from "../helpers/runtime.js";

/**
 * The activity-ping tier: the push half of the context-window contract.
 *
 * This is the headline claim on the README — "one line per quiet period,
 * coalesced" — and nothing tested it. The only coverage of index.ts was ten
 * lines of `typeof` assertions. The tier is the one place where a peer's
 * behaviour reaches an agent without the agent asking, so its filtering and
 * batching are exactly what a bound depends on: a ping per message would defeat
 * the point of keeping the transcript out of context.
 *
 * These run against a real broker over a real socket, with a fake host, because
 * the interesting behaviour is what arrives after a round trip.
 */

// index.ts coalesces over a 1.5 s window. Waits below are derived from it rather
// than restated, so a change there does not leave a stale literal here.
const COALESCE_WINDOW_MS = 1500;
const AFTER_FLUSH_MS = COALESCE_WINDOW_MS + 600;

interface SentMessage {
	customType?: string;
	content: string;
	display?: boolean;
}

function fakeHost(sessionName: string) {
	const sent: SentMessage[] = [];
	const shutdownHandlers: Array<() => void> = [];
	const pi = {
		registerTool: vi.fn(),
		getSessionName: () => sessionName,
		sendMessage: vi.fn((message: SentMessage) => {
			sent.push(message);
		}),
		on: vi.fn((event: string, handler: () => void) => {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		}),
	} as unknown as ExtensionAPI;
	return {
		pi,
		sent,
		shutdown: () => {
			for (const handler of shutdownHandlers) handler();
		},
	};
}

describe("roundtable activity coalescing", () => {
	let agentDir: string;
	let socketPath: string;
	let broker: RoundtableBroker;
	const clients: RoundtableClient[] = [];
	const hosts: Array<() => void> = [];

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "roundtable-activity-"));
		socketPath = getBrokerSocketPath(process.platform, agentDir);
		// The extension resolves the socket from the agent dir, so point it here
		// rather than at the developer's real broker.
		process.env.ORPHUS_CODING_AGENT_DIR = agentDir;
		broker = new RoundtableBroker(socketPath, getBrokerPidPath(agentDir), getRoundtableDirPath(agentDir));
		await new Promise<void>((resolve) => broker.start(resolve));
	});

	afterEach(() => {
		for (const shutdown of hosts.splice(0)) shutdown();
		for (const client of clients.splice(0)) client.disconnect();
		broker.shutdown();
		delete process.env.ORPHUS_CODING_AGENT_DIR;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function peer(name: string): Promise<RoundtableClient> {
		const client = new RoundtableClient(name, socketPath);
		await client.connect();
		clients.push(client);
		return client;
	}

	/**
	 * Boot the extension against the live broker and join it to a room.
	 *
	 * The join goes through the extension's *own* registered tool rather than a
	 * separate client, because that is what triggers its lazy connect and
	 * installs the activity subscription. Joining with a side client would leave
	 * the extension disconnected, and every assertion below would pass vacuously
	 * against a listener that was never listening.
	 */
	async function listener(name: string, room: string) {
		const host = fakeHost(name);
		hosts.push(host.shutdown);
		roundtableExtension(host.pi);

		const registered = (host.pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(
			([tool]) => tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> },
		);
		const roundtable = registered.find((tool) => tool.name === "roundtable");
		assert.ok(roundtable, "the extension registered no roundtable tool");

		const call = (params: Record<string, unknown>) =>
			roundtable.execute("call", params, undefined, undefined, undefined as never);
		await call({ action: "join", room });
		return { host, call };
	}

	it("registers its tools against the host", async () => {
		const host = fakeHost("planner");
		hosts.push(host.shutdown);
		roundtableExtension(host.pi);
		const names = (host.pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(
			([tool]) => (tool as { name: string }).name,
		);
		expect(names).toContain("roundtable");
	});

	// Ten posts in one window must cost one line, not ten. This is the property
	// the README states and the reason the tier is safe to have at all.
	it("collapses a burst into one line per quiet period", async () => {
		const { host } = await listener("reviewer", "design");
		const planner = await peer("planner");
		await planner.join("design");

		for (let i = 1; i <= 10; i++) await planner.post("design", `message ${i}`);
		await sleep(AFTER_FLUSH_MS);

		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 1, `expected one coalesced ping, got ${pings.length}`);
		expect(pings[0]?.content).toMatch(/#design: 10 new \(planner\)/u);
	});

	// A stale extension ctx after session replacement throws from sendMessage —
	// inside a timer callback, where an uncaught throw kills the whole process.
	// AgentSession.dispose() invalidates captured ctxs WITHOUT emitting
	// session_shutdown, so the old instance's broker client survives as an
	// orphan and keeps receiving activity. The ping tier is best-effort by
	// contract: delivery failure must quiesce the orphan (drop the ping,
	// disconnect from the broker), never crash, and never ping again.
	// Regression: a /fleet run pinning the orchestrator model died before its
	// first turn when retained-room activity hit the replaced session's ctx.
	it("quiesces instead of crashing when ping delivery hits a stale ctx", async () => {
		const { host } = await listener("worker", "design");
		(host.pi.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});

		const planner = await peer("planner");
		await planner.join("design");
		await planner.post("design", "message after the ctx went stale");
		await sleep(AFTER_FLUSH_MS);

		// The flush attempted delivery exactly once and swallowed the throw.
		const attempts = (host.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length;
		assert.equal(attempts, 1, `expected one swallowed delivery attempt, got ${attempts}`);

		// The orphan disconnected itself from the broker, so further activity
		// never reaches it: no new delivery attempts, from a fresh timer or
		// otherwise.
		await planner.post("design", "second message");
		await sleep(AFTER_FLUSH_MS);
		assert.equal(
			(host.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length,
			attempts,
			"a quiesced instance must not attempt further pings",
		);
	});

	// Quiescence is permanent: clearing live state alone would let a connect
	// that was in flight during quiesce() restore an active client afterwards,
	// and a dead instance must also refuse to build a NEW connection when a
	// stray tool call arrives after shutdown.
	it("refuses new connections after quiescing", async () => {
		const { host, call } = await listener("worker", "design");
		host.shutdown(); // session_shutdown → quiesce

		const result = (await call({ action: "rooms" })) as { output?: string; isError?: boolean };
		const text = JSON.stringify(result);
		expect(text).toMatch(/quiesced/u);

		// And no ping machinery survives: nothing was delivered after shutdown.
		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 0);
	});

	it("names each distinct author once, however many times they posted", async () => {
		const { host } = await listener("reviewer", "design");
		const planner = await peer("planner");
		const critic = await peer("critic");
		await planner.join("design");
		await critic.join("design");

		await planner.post("design", "one");
		await critic.post("design", "two");
		await planner.post("design", "three");
		await sleep(AFTER_FLUSH_MS);

		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 1);
		const content = pings[0]?.content ?? "";
		expect(content).toMatch(/#design: 3 new/u);
		expect(content).toMatch(/planner/u);
		expect(content).toMatch(/critic/u);
		// Authors are a set: a chatty peer must not lengthen the line per message.
		assert.equal(content.match(/planner/gu)?.length, 1);
	});

	it("groups concurrent rooms into a single line rather than one ping each", async () => {
		const { host, call } = await listener("reviewer", "design");
		await call({ action: "join", room: "infra" });

		const planner = await peer("planner");
		await planner.join("design");
		await planner.join("infra");
		await planner.post("design", "design note");
		await planner.post("infra", "infra note");
		await sleep(AFTER_FLUSH_MS);

		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 1, "two rooms in one window is still one quiet period");
		const content = pings[0]?.content ?? "";
		expect(content).toMatch(/#design: 1 new/u);
		expect(content).toMatch(/#infra: 1 new/u);
	});

	// Membership churn carries seq 0. Counting it as content is what made joining
	// a room with history announce a message that does not exist.
	it("does not ping for joins or departures", async () => {
		const { host } = await listener("reviewer", "design");
		const planner = await peer("planner");
		await planner.join("design");
		await planner.post("design", "real content");
		await planner.leave("design");
		const late = await peer("late");
		await late.join("design");
		await sleep(AFTER_FLUSH_MS);

		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 1);
		// One post happened; the join, the leave, and the late join must not count.
		expect(pings[0]?.content).toMatch(/#design: 1 new \(planner\)/u);
	});

	it("carries no message bodies into the host", async () => {
		const { host } = await listener("reviewer", "design");
		const planner = await peer("planner");
		await planner.join("design");
		const secret = "SENSITIVE-TRANSCRIPT-BODY-THAT-MUST-NOT-BE-PUSHED";
		await planner.post("design", secret);
		await sleep(AFTER_FLUSH_MS);

		// Prove the metadata push happened before checking that content only enters
		// context when the agent asks for a digest.
		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 1, "no activity ping arrived");
		for (const message of host.sent) assert.ok(!message.content.includes(secret));
	});

	it("starts a fresh window after a flush instead of staying silent", async () => {
		const { host } = await listener("reviewer", "design");
		const planner = await peer("planner");
		await planner.join("design");

		await planner.post("design", "first burst");
		await sleep(AFTER_FLUSH_MS);
		await planner.post("design", "second burst");
		await sleep(AFTER_FLUSH_MS);

		const pings = host.sent.filter((m) => m.customType === "roundtable_activity");
		assert.equal(pings.length, 2, "a later burst must ping again");
	});
});
