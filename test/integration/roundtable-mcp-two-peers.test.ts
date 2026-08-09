import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, test } from "vitest";
import { BRIDGE_TOOL_NAMES } from "../../packages/roundtable/mcp/register-tools.js";
import { bunExecutable, moduleDir } from "../helpers/runtime.js";

/**
 * Structural: boots two real bin child processes under Bun, and the first tool
 * call also spawns and waits for a real broker. Named per the per-test timeout
 * policy in AGENTS.md.
 */
const REAL_MCP_BRIDGE_SCENARIO_TIMEOUT_MS = 120_000;

const BIN = join(moduleDir(import.meta.url), "../../packages/roundtable/bin/orphus-roundtable-mcp.ts");

let agentDir: string;
const peers: Client[] = [];

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

async function connectPeer(role: string): Promise<Client> {
	// Strip session markers the same way the workflow CLI test does, then pin
	// the agent dir so this suite's broker socket cannot collide with a real one.
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("ORPHUS_")) environment[key] = value;
	}
	environment.ORPHUS_CODING_AGENT_DIR = agentDir;

	const client = new Client({ name: `test-${role}`, version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({ command: bunExecutable(), args: [BIN, "--as", role], env: environment }),
	);
	peers.push(client);
	return client;
}

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "orphus-mcp-bridge-"));
});

afterAll(async () => {
	for (const peer of peers) await peer.close();
	rmSync(agentDir, { recursive: true, force: true });
});

test(
	"two external peers join, post, and each digest attributes the other correctly",
	async () => {
		const planner = await connectPeer("planner");
		const critic = await connectPeer("critic");

		const listed = await planner.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...BRIDGE_TOOL_NAMES].sort());

		await planner.callTool({ name: "roundtable_join", arguments: { room: "bridge-test", topic: "attribution" } });
		await critic.callTool({ name: "roundtable_join", arguments: { room: "bridge-test" } });

		const posted = await planner.callTool({
			name: "roundtable_post",
			arguments: { room: "bridge-test", message: "GCRA over token bucket: one float per key." },
		});
		assert.match(textOf(posted), /planner#\d+/u);

		// Digest BEFORE posting: the broker marks an author's own message read
		// (room-store.post advances the author cursor), so a peer that replies
		// first silently skips everything earlier — the same etiquette the
		// roundtable skill teaches. The critic's digest must attribute the
		// planner's message to "planner", from the pinned role, not model text.
		const criticDigest = await critic.callTool({ name: "roundtable_digest", arguments: { room: "bridge-test" } });
		assert.match(textOf(criticDigest), /planner#\d+.*GCRA/u);

		await critic.callTool({
			name: "roundtable_post",
			arguments: { room: "bridge-test", message: "Agreed, given the reconciliation window." },
		});

		const plannerDigest = await planner.callTool({ name: "roundtable_digest", arguments: { room: "bridge-test" } });
		assert.match(textOf(plannerDigest), /critic#\d+.*Agreed/u);

		// A digest consumed the unread state: a second digest has nothing new.
		const second = await critic.callTool({ name: "roundtable_digest", arguments: { room: "bridge-test" } });
		assert.match(textOf(second), /0 unread|No new messages/u);
	},
	REAL_MCP_BRIDGE_SCENARIO_TIMEOUT_MS,
);
