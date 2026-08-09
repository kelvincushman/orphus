import assert from "node:assert/strict";
import { test } from "vitest";
import {
	BRIDGE_TOOL_NAMES,
	registerBridgeTools,
	type ToolRegistrar,
} from "../../packages/roundtable/mcp/register-tools.js";
import type { RoundtableToolParams, RoundtableToolResult } from "../../packages/roundtable/roundtable-tool.js";

interface Registered {
	config: { description: string; inputSchema: Record<string, unknown> };
	handler: (
		args: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>;
}

function capture(): { registrar: ToolRegistrar; tools: Map<string, Registered>; calls: RoundtableToolParams[] } {
	const tools = new Map<string, Registered>();
	const calls: RoundtableToolParams[] = [];
	const registrar: ToolRegistrar = {
		registerTool(name, config, handler) {
			tools.set(name, { config, handler });
		},
	};
	return { registrar, tools, calls };
}

const okExecute =
	(calls: RoundtableToolParams[]) =>
	async (params: RoundtableToolParams): Promise<RoundtableToolResult> => {
		calls.push(params);
		return { isError: false, content: [{ type: "text", text: `did ${params.action}` }], details: {} };
	};

test("registers exactly the eight bridge tools", () => {
	const { registrar, tools, calls } = capture();
	registerBridgeTools(registrar, okExecute(calls));
	assert.deepEqual([...tools.keys()].sort(), [...BRIDGE_TOOL_NAMES].sort());
	assert.equal(tools.size, 8);
});

test("each tool maps its arguments onto the builtin action's params", async () => {
	const { registrar, tools, calls } = capture();
	registerBridgeTools(registrar, okExecute(calls));

	await tools.get("roundtable_rooms")!.handler({});
	await tools.get("roundtable_join")!.handler({ room: "design", topic: "rate limiter" });
	await tools.get("roundtable_leave")!.handler({ room: "design" });
	await tools.get("roundtable_post")!.handler({ room: "design", message: "GCRA wins", replyTo: "m-1" });
	await tools.get("roundtable_digest")!.handler({ room: "design", budget: 4000, perMessage: 300 });
	await tools.get("roundtable_peek")!.handler({ room: "design" });
	await tools.get("roundtable_fetch")!.handler({ room: "design", afterSeq: 12, limit: 5 });
	await tools.get("roundtable_export")!.handler({ room: "design", path: "raw/design.md" });

	assert.deepEqual(calls, [
		{ action: "rooms" },
		{ action: "join", room: "design", topic: "rate limiter" },
		{ action: "leave", room: "design" },
		{ action: "post", room: "design", message: "GCRA wins", replyTo: "m-1" },
		{ action: "digest", room: "design", budget: 4000, perMessage: 300 },
		{ action: "peek", room: "design" },
		{ action: "fetch", room: "design", afterSeq: 12, limit: 5 },
		{ action: "export", room: "design", path: "raw/design.md" },
	]);
});

test("no tool schema accepts a role — identity is pinned, not model-controlled", () => {
	const { registrar, tools, calls } = capture();
	registerBridgeTools(registrar, okExecute(calls));
	for (const [name, tool] of tools) {
		assert.ok(!("role" in tool.config.inputSchema), `${name} must not expose a role parameter`);
		assert.ok(!("as" in tool.config.inputSchema), `${name} must not expose an as parameter`);
	}
});

test("results pass content and isError through and drop internal details", async () => {
	const { registrar, tools } = capture();
	registerBridgeTools(registrar, async () => ({
		isError: true,
		content: [{ type: "text", text: "Roundtable post failed: no such room" }],
		details: { error: true },
	}));
	const result = await tools.get("roundtable_post")!.handler({ room: "ghost", message: "hi" });
	assert.deepEqual(result, {
		content: [{ type: "text", text: "Roundtable post failed: no such room" }],
		isError: true,
	});
});

test("export's description warns that it returns whole transcripts", () => {
	const { registrar, tools, calls } = capture();
	registerBridgeTools(registrar, okExecute(calls));
	assert.match(tools.get("roundtable_export")!.config.description, /digest/iu);
});
