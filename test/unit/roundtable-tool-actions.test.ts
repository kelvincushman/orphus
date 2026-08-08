import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoundtableBroker } from "../../packages/roundtable/broker/broker.js";
import { RoundtableClient } from "../../packages/roundtable/broker/client.js";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../../packages/roundtable/broker/paths.js";
import { createRoundtableTool, type RoundtableToolParams } from "../../packages/roundtable/roundtable-tool.js";

/**
 * Behavioural tests for the agent-facing tool.
 *
 * The tool previously had only `typeof` assertions against its exported shape,
 * so the whole surface an agent actually touches — which actions advance the
 * read cursor, what a missing parameter does, whether a tier is reachable at
 * all — was uncovered. These run against the real broker over a real socket,
 * because the interesting behaviour is in the round trip.
 */

describe("roundtable tool actions", () => {
	let agentDir: string;
	let socketPath: string;
	let broker: RoundtableBroker;
	const clients: RoundtableClient[] = [];

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "roundtable-tool-"));
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

	/** The tool returns content as blocks; every assertion here wants the text. */
	function textOf(result: { content: Array<{ type: "text"; text: string }> }): string {
		return result.content.map((block) => block.text).join("\n");
	}

	function toolFor(client: RoundtableClient, role = "planner") {
		const tool = createRoundtableTool({
			ensureConnected: vi.fn(async () => client),
			exportRoot: join(agentDir, "memory"),
			currentRole: () => role,
			writerRole: "librarian",
		});
		return (params: RoundtableToolParams) => tool.execute("call-1", params, undefined, undefined, undefined as never);
	}

	it("reports missing parameters and unknown actions without reaching the broker", async () => {
		const run = toolFor(await connect("planner"));

		for (const action of ["join", "leave", "post", "digest", "peek", "fetch"] as const) {
			const result = await run({ action } as RoundtableToolParams);
			assert.equal(result.isError, true, `${action} without a room must error`);
			expect(textOf(result)).toMatch(/Missing 'room'/u);
		}
		const noMessage = await run({ action: "post", room: "design" } as RoundtableToolParams);
		assert.equal(noMessage.isError, true);

		const unknown = await run({ action: "nope" } as unknown as RoundtableToolParams);
		assert.equal(unknown.isError, true);
		expect(textOf(unknown)).toMatch(/Unknown action/u);
	});

	it("advances the read cursor on digest but leaves it untouched on peek and fetch", async () => {
		const planner = await connect("planner");
		const reviewer = await connect("reviewer");
		await planner.join("design");
		await reviewer.join("design");
		for (let i = 1; i <= 3; i++) await planner.post("design", `message ${i}`);

		const run = toolFor(reviewer, "reviewer");

		const peeked = await run({ action: "peek", room: "design" });
		assert.equal(peeked.isError, false);
		assert.equal(peeked.details.consumedSeq, 3);
		// Still unread: peek renders the same content but must not consume it.
		assert.equal((await run({ action: "peek", room: "design" })).details.consumedSeq, 3);

		const fetched = await run({ action: "fetch", room: "design" });
		assert.equal(fetched.isError, false);
		assert.equal((await run({ action: "peek", room: "design" })).details.consumedSeq, 3);

		const digested = await run({ action: "digest", room: "design" });
		assert.equal(digested.details.consumedSeq, 3);
		// Consumed now, so a second digest finds nothing.
		const after = await run({ action: "digest", room: "design" });
		assert.equal(after.details.consumedSeq, 0);
	});

	// The third delivery tier from DESIGN.md. It existed in the client and the
	// wire protocol but had no way in from the tool, while the digest's own
	// collapse marker told agents to "fetch by seq to expand".
	it("returns raw messages by sequence range, unbounded by the digest budget", async () => {
		const planner = await connect("planner");
		await planner.join("design");
		const long = "x".repeat(3000);
		await planner.post("design", "first");
		await planner.post("design", long);

		const run = toolFor(planner);
		const result = await run({ action: "fetch", room: "design", afterSeq: 1 });
		assert.equal(result.isError, false);
		assert.equal(result.details.messages, 1);
		// A digest would have truncated this to the per-message cap; fetch must not.
		expect(textOf(result)).toContain(long);

		const all = await run({ action: "fetch", room: "design", afterSeq: 0 });
		assert.equal(all.details.messages, 2);

		const limited = await run({ action: "fetch", room: "design", afterSeq: 0, limit: 1 });
		assert.equal(limited.details.messages, 1);

		const empty = await run({ action: "fetch", room: "design", afterSeq: 99 });
		assert.equal(empty.isError, false);
		assert.equal(empty.details.messages, 0);
	});

	// The role footer instructs every launched agent to respect a per-message
	// budget, and until now no agent could apply one.
	it("applies a per-message cap that the caller supplies", async () => {
		const planner = await connect("planner");
		const reviewer = await connect("reviewer");
		await planner.join("design");
		await reviewer.join("design");
		// Posted by a peer: posting marks the author's own cursor read, so a
		// digest taken by the author would be empty and prove nothing.
		await planner.post("design", "y".repeat(2000));

		const run = toolFor(reviewer, "reviewer");
		const wide = (await run({ action: "peek", room: "design", budget: 4000 })).details.chars ?? 0;
		const narrow = (await run({ action: "peek", room: "design", budget: 4000, perMessage: 100 })).details.chars ?? 0;
		assert.ok(wide > 0, "the wide digest should have rendered something");
		assert.ok(narrow < wide, `perMessage must shrink the digest: ${narrow} vs ${wide}`);
	});

	// Without this an agent had to peek every room to find out where the work
	// was — a digest each time, which is what the cheap listing exists to avoid.
	it("reports unread-for-me in the room listing, per role", async () => {
		const planner = await connect("planner");
		const reviewer = await connect("reviewer");
		await planner.join("design");
		await reviewer.join("design");
		for (let i = 1; i <= 4; i++) await planner.post("design", `message ${i}`);

		// The author has read their own messages; the reviewer has read none.
		const plannerRooms = await toolFor(planner)({ action: "rooms" });
		expect(textOf(plannerRooms)).toMatch(/#design .*0 unread/u);
		assert.equal(plannerRooms.details.unread, 0);

		const reviewerList = toolFor(reviewer, "reviewer");
		const before = await reviewerList({ action: "rooms" });
		expect(textOf(before)).toMatch(/#design .*4 unread/u);
		assert.equal(before.details.unread, 4);

		await reviewerList({ action: "digest", room: "design" });
		const after = await reviewerList({ action: "rooms" });
		assert.equal(after.details.unread, 0);
	});
});
