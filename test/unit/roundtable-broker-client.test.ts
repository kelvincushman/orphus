import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import net from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoundtableBroker } from "../../packages/roundtable/broker/broker.ts";
import { RoundtableClient } from "../../packages/roundtable/broker/client.ts";
import { createMessageReader, writeMessage } from "../../packages/roundtable/broker/framing.ts";
import {
	getBrokerPidPath,
	getBrokerPidPathForSocket,
	getBrokerSocketPath,
	getRoundtableDirPath,
} from "../../packages/roundtable/broker/paths.ts";
import { MAX_MEMBER_NAME_CHARS, type RoundtableBrokerMessage } from "../../packages/roundtable/types.ts";

describe("roundtable broker and client over a real socket", () => {
	let agentDir: string;
	let broker: RoundtableBroker;
	let socketPath: string;
	const clients: RoundtableClient[] = [];

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "roundtable-test-"));
		socketPath = getBrokerSocketPath(process.platform, agentDir);
		broker = new RoundtableBroker(socketPath, getBrokerPidPath(agentDir), getRoundtableDirPath(agentDir));
		await broker.start();
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
		const deadline = Date.now() + 2000;
		while (!criticEvents.some((event) => event.seq === 1) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

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

	it("distinguishes a missing room from a room the session has not joined", async () => {
		const outsider = await connect("outsider");
		await expect(outsider.post("nowhere", "hi")).rejects.toThrow(/does not exist/);

		const member = await connect("member");
		await member.join("design");
		await expect(outsider.post("design", "hi")).rejects.toThrow(/Not a member/);
	});

	it("keeps the live broker reachable when a second broker races for its socket", async () => {
		expect((broker as unknown as { server: net.Server }).server.listenerCount("error")).toBeGreaterThan(0);
		const contender = new RoundtableBroker(socketPath, getBrokerPidPath(agentDir), getRoundtableDirPath(agentDir));
		await expect(contender.start()).rejects.toThrow(/already listening|failed to listen/);
		contender.shutdown();
		expect(readFileSync(getBrokerPidPath(agentDir), "utf8")).toBe(String(process.pid));

		const client = await connect("still-alive");
		expect(client.connected).toBe(true);
	});

	it.skipIf(process.platform === "win32")("creates the parent directory for a custom socket path", async () => {
		const customSocket = join(agentDir, "missing", "custom.sock");
		const customBroker = new RoundtableBroker(customSocket, join(agentDir, "custom.pid"), agentDir);
		await customBroker.start();
		const client = new RoundtableClient("custom", customSocket);
		await client.connect();
		expect(client.connected).toBe(true);
		client.disconnect();
		customBroker.shutdown();
	});

	it("clears an armed idle-shutdown timer", async () => {
		const client = await connect("idle-timer");
		client.disconnect();
		const state = broker as unknown as { shutdownTimer: NodeJS.Timeout | null };
		const deadline = Date.now() + 2000;
		while (!state.shutdownTimer && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(state.shutdownTimer).not.toBeNull();
		broker.shutdown();
		expect(state.shutdownTimer).toBeNull();
	});

	it("rejects repeated registration on one socket without replacing the session", async () => {
		const socket = net.createConnection(socketPath);
		await once(socket, "connect");
		const nextMessage = () =>
			new Promise<RoundtableBrokerMessage>((resolve, reject) => {
				const reader = createMessageReader((message) => {
					socket.off("data", reader);
					resolve(message as RoundtableBrokerMessage);
				}, reject);
				socket.on("data", reader);
			});

		const first = nextMessage();
		writeMessage(socket, { type: "register", name: "raw", pid: process.pid, cwd: process.cwd() });
		expect((await first).type).toBe("registered");

		const second = nextMessage();
		writeMessage(socket, { type: "register", name: "raw-again", pid: process.pid, cwd: process.cwd() });
		const response = await second;
		expect(response.type).toBe("error");
		if (response.type === "error") expect(response.error).toMatch(/already registered/);
		socket.destroy();
	});

	it("rejects empty and oversized member names on a raw socket", async () => {
		const socket = net.createConnection(socketPath);
		await once(socket, "connect");
		const nextMessage = () =>
			new Promise<RoundtableBrokerMessage>((resolve, reject) => {
				const reader = createMessageReader((message) => {
					socket.off("data", reader);
					resolve(message as RoundtableBrokerMessage);
				}, reject);
				socket.on("data", reader);
			});

		for (const name of ["", "x".repeat(MAX_MEMBER_NAME_CHARS + 1)]) {
			const response = nextMessage();
			writeMessage(socket, { type: "register", name, pid: process.pid, cwd: process.cwd() });
			const message = await response;
			expect(message.type).toBe("error");
			if (message.type === "error") expect(message.error).toMatch(/1-128 characters/);
		}
		socket.destroy();
	});

	it("can retry the same client after an initial connection failure", async () => {
		const retryAgentDir = join(agentDir, "retry");
		const retrySocket = getBrokerSocketPath(process.platform, retryAgentDir);
		const retryClient = new RoundtableClient("retry", retrySocket);
		await expect(retryClient.connect()).rejects.toThrow();

		const retryBroker = new RoundtableBroker(
			retrySocket,
			getBrokerPidPath(retryAgentDir),
			getRoundtableDirPath(retryAgentDir),
		);
		await retryBroker.start();
		await retryClient.connect();
		expect(retryClient.connected).toBe(true);
		retryClient.disconnect();
		retryBroker.shutdown();
	});

	it("shares registration work across concurrent connect callers", async () => {
		const client = new RoundtableClient("concurrent", socketPath);
		const first = client.connect();
		const second = client.connect();
		expect(second).toBe(first);
		await second;
		expect(client.connected).toBe(true);
		client.disconnect();
	});

	it("rejects pending requests immediately on an intentional disconnect", async () => {
		const pendingSocket =
			process.platform === "win32"
				? getBrokerSocketPath("win32", `${agentDir}-pending`)
				: join(agentDir, "pending.sock");
		const acceptedSockets: net.Socket[] = [];
		const silentServer = net.createServer((socket) => {
			acceptedSockets.push(socket);
			const reader = createMessageReader(
				(message) => {
					if ((message as { type?: string }).type === "register") {
						writeMessage(socket, { type: "registered", sessionId: "pending-session" });
					}
				},
				() => socket.destroy(),
			);
			socket.on("data", reader);
		});
		await new Promise<void>((resolve) => silentServer.listen(pendingSocket, resolve));
		const client = new RoundtableClient("pending", pendingSocket, 2000);
		await client.connect();
		const pending = client.fetch("design", 0);
		client.disconnect();
		await expect(pending).rejects.toThrow(/connection closed/);
		for (const socket of acceptedSockets) socket.destroy();
		await new Promise<void>((resolve, reject) => silentServer.close((error) => (error ? reject(error) : resolve())));
	});

	it("does not let an old registration timeout clear a replacement connection", async () => {
		const retrySocket =
			process.platform === "win32"
				? getBrokerSocketPath("win32", `${agentDir}-stale`)
				: join(agentDir, "stale.sock");
		const silentServer = net.createServer();
		await new Promise<void>((resolve) => silentServer.listen(retrySocket, resolve));
		const accepted = once(silentServer, "connection");
		const retryClient = new RoundtableClient("retry", retrySocket, 250);
		const staleFailure = retryClient.connect().catch((error: unknown) => error);
		const [acceptedSocket] = (await accepted) as [net.Socket];
		const acceptedClose = once(acceptedSocket, "close");
		retryClient.disconnect();
		await acceptedClose;
		await new Promise<void>((resolve, reject) => silentServer.close((error) => (error ? reject(error) : resolve())));
		const staleError = await staleFailure;
		expect(staleError).toBeInstanceOf(Error);

		const retryBroker = new RoundtableBroker(retrySocket, join(agentDir, "stale.pid"), agentDir);
		await retryBroker.start();
		await retryClient.connect();
		// Wait beyond the first attempt's registration deadline: none of its
		// cleanup may clear the replacement connection.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(retryClient.connected).toBe(true);
		retryClient.disconnect();
		retryBroker.shutdown();
	});
});

// The Windows named-pipe name derives from the agent dir. A lossy sanitizer
// would collide distinct dirs onto one machine-global pipe; the name must be
// unique per full path.
describe("windows broker pipe naming", () => {
	it("gives distinct agent dirs distinct pipe names despite punctuation", () => {
		const names = ["C:\\agents\\team.one", "C:\\agents\\team_one", "C:\\agents\\team-one"].map((d) =>
			getBrokerSocketPath("win32", d),
		);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name.startsWith("\\\\.\\pipe\\atomic-roundtable-")).toBe(true);
	});

	it("is deterministic for the same agent dir", () => {
		expect(getBrokerSocketPath("win32", "C:\\agents\\x")).toBe(getBrokerSocketPath("win32", "C:\\agents\\x"));
	});

	it("normalizes trailing separators and bounds the readable pipe name", () => {
		expect(getBrokerSocketPath("win32", "C:\\agents\\x\\")).toBe(getBrokerSocketPath("win32", "C:\\agents\\x"));
		expect(getBrokerSocketPath("win32", "C:\\agents\\Team.One")).toBe(
			getBrokerSocketPath("win32", "c:\\AGENTS\\team.one"),
		);
		const sharedPrefix = `C:\\agents\\${"nested-".repeat(20)}`;
		expect(getBrokerSocketPath("win32", `${sharedPrefix}alpha`)).not.toBe(
			getBrokerSocketPath("win32", `${sharedPrefix}beta`),
		);
	});

	it("derives custom pid files without sharing the default owner file", () => {
		expect(getBrokerPidPathForSocket("/tmp/custom.sock", "darwin", "/agent")).toBe("/tmp/custom.sock.pid");
		expect(getBrokerPidPathForSocket("\\\\.\\pipe\\custom-a", "win32", "C:\\agent")).not.toBe(
			getBrokerPidPathForSocket("\\\\.\\pipe\\custom-b", "win32", "C:\\agent"),
		);
	});
});
