#!/usr/bin/env bun
// Stdio MCP server that lets an external agent CLI join roundtable rooms as a
// peer. Identity is pinned by --as at launch; see mcp/cli.ts for why.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
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
// the adapter narrows through one explicit cast. The SDK still validates every
// call against the z.object schema at runtime, and the two-peer integration
// test exercises the registered tools end to end.
type DynamicRegisterTool = (
  name: string,
  config: { description?: string; inputSchema?: z.ZodTypeAny },
  cb: (args: unknown) => Promise<unknown>,
) => unknown;
const registrar: ToolRegistrar = {
  registerTool(name, config, handler) {
    (server.registerTool as unknown as DynamicRegisterTool)(
      name,
      {
        description: config.description,
        inputSchema: z.object(config.inputSchema as z.ZodRawShape),
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
