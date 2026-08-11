#!/usr/bin/env bun
// Stdio MCP server that lets an external agent CLI join roundtable rooms as a
// peer. Identity is pinned by --as at launch; see mcp/cli.ts for why.
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Type } from "typebox";
import { createBridgeDeps } from "../mcp/bridge-deps.js";
import { parseBridgeArgs } from "../mcp/cli.js";
import { registerBridgeTools, type ToolRegistrar } from "../mcp/register-tools.js";
import { createRoundtableTool } from "../roundtable-tool.js";

const parsed = parseBridgeArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(parsed.error);
  process.exit(2);
}

const deps = createBridgeDeps(parsed.role);
const tool = createRoundtableTool(deps);

// serveStdio takes a factory (the 2026-07-28 stateless core pins one instance
// per connection); stdio carries exactly one connection, so one shared server
// is correct. The registrar adapts our raw-shape specs to the SDK's current
// z.object form — the raw-shape registerTool overload is deprecated.
const server = new McpServer({ name: "orphus-roundtable", version: "0.0.0" });
// registerTool's overloads type each tool's callback against its own schema
// generic; a dynamic fan-in over eight specs cannot carry that relationship, so
// the adapter narrows through one explicit cast. Schemas are TypeBox (the
// repo's schema tool) adapted via the SDK's own fromJsonSchema — TypeBox
// schemas ARE JSON Schema — and the SDK validates every call at runtime; the
// two-peer integration test exercises the registered tools end to end.
type DynamicRegisterTool = (
  name: string,
  config: { description?: string; inputSchema?: unknown },
  cb: (args: unknown) => Promise<unknown>,
) => unknown;
const registrar: ToolRegistrar = {
  registerTool(name, config, handler) {
    (server.registerTool as unknown as DynamicRegisterTool)(
      name,
      {
        description: config.description,
        inputSchema: fromJsonSchema(
          Type.Object(config.inputSchema as Parameters<typeof Type.Object>[0], { additionalProperties: false }),
        ),
      },
      async (args: unknown) => handler((args ?? {}) as Record<string, unknown>),
    );
  },
};
registerBridgeTools(registrar, (params) =>
  tool.execute("mcp-bridge", params, new AbortController().signal, undefined, undefined as never),
);

process.on("exit", () => deps.disconnect());
serveStdio(() => server);
