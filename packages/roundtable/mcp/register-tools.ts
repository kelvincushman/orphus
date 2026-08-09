import * as z from "zod";
import type { RoundtableToolParams, RoundtableToolResult } from "../roundtable-tool.js";

export interface BridgeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** Structural subset of the SDK's McpServer, so units need no SDK. */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: { description: string; inputSchema: Record<string, unknown> },
    handler: (args: Record<string, unknown>) => Promise<BridgeToolResult>,
  ): void;
}

interface BridgeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  toParams(args: Record<string, unknown>): RoundtableToolParams;
}

const room = z.string().describe("Room name");

/**
 * One MCP tool per broker action rather than one tool with an `action`
 * discriminator: the model sees exactly which arguments each action takes, and
 * the SDK validates before the handler runs. Identity is deliberately absent
 * from every schema — the role was pinned at server startup.
 */
const BRIDGE_TOOLS: readonly BridgeToolSpec[] = [
  {
    name: "roundtable_rooms",
    description: "List roundtable rooms with unread counts and members.",
    inputSchema: {},
    toParams: () => ({ action: "rooms" }),
  },
  {
    name: "roundtable_join",
    description: "Join a room (creates it if missing). Cursors and attribution use your pinned role.",
    inputSchema: { room, topic: z.string().optional().describe("Room topic when creating") },
    toParams: (a) => ({ action: "join", room: a.room as string, ...(a.topic !== undefined ? { topic: a.topic as string } : {}) }),
  },
  {
    name: "roundtable_leave",
    description: "Leave a room.",
    inputSchema: { room },
    toParams: (a) => ({ action: "leave", room: a.room as string }),
  },
  {
    name: "roundtable_post",
    description: "Post a message to a room. Post conclusions, not transcripts.",
    inputSchema: {
      room,
      message: z.string().describe("Message to post"),
      replyTo: z.string().optional().describe("Message id to reply to"),
    },
    toParams: (a) => ({
      action: "post",
      room: a.room as string,
      message: a.message as string,
      ...(a.replyTo !== undefined ? { replyTo: a.replyTo as string } : {}),
    }),
  },
  {
    name: "roundtable_digest",
    description: "Pull unread as a character-budgeted digest and mark it read. The primary catch-up mechanism.",
    inputSchema: {
      room,
      budget: z.number().optional().describe("Digest character budget (default 2000, floored at 200)"),
      perMessage: z.number().optional().describe("Per-message verbatim cap (default 600, floored at 80)"),
    },
    toParams: (a) => ({
      action: "digest",
      room: a.room as string,
      ...(a.budget !== undefined ? { budget: a.budget as number } : {}),
      ...(a.perMessage !== undefined ? { perMessage: a.perMessage as number } : {}),
    }),
  },
  {
    name: "roundtable_peek",
    description: "Digest WITHOUT marking read — look at a room without consuming its unread state.",
    inputSchema: {
      room,
      budget: z.number().optional().describe("Digest character budget (default 2000, floored at 200)"),
      perMessage: z.number().optional().describe("Per-message verbatim cap (default 600, floored at 80)"),
    },
    toParams: (a) => ({
      action: "peek",
      room: a.room as string,
      ...(a.budget !== undefined ? { budget: a.budget as number } : {}),
      ...(a.perMessage !== undefined ? { perMessage: a.perMessage as number } : {}),
    }),
  },
  {
    name: "roundtable_fetch",
    description: "Raw messages by sequence range, no digest. Use to expand messages a digest collapsed.",
    inputSchema: {
      room,
      afterSeq: z.number().optional().describe("Return messages with seq greater than this (defaults to your cursor)"),
      limit: z.number().optional().describe("Maximum messages to return (default 20)"),
    },
    toParams: (a) => ({
      action: "fetch",
      room: a.room as string,
      ...(a.afterSeq !== undefined ? { afterSeq: a.afterSeq as number } : {}),
      ...(a.limit !== undefined ? { limit: a.limit as number } : {}),
    }),
  },
  {
    name: "roundtable_export",
    description:
      "Write a room's retained transcript to the shared memory raw/ directory. Whole-transcript extraction — for catching up, use roundtable_digest instead; export is for staging memory ingest, and only the writer role may call it.",
    inputSchema: { room, path: z.string().describe("Relative file under the memory raw/ directory") },
    toParams: (a) => ({ action: "export", room: a.room as string, path: a.path as string }),
  },
];

export const BRIDGE_TOOL_NAMES: readonly string[] = BRIDGE_TOOLS.map((tool) => tool.name);

export function registerBridgeTools(
  registrar: ToolRegistrar,
  execute: (params: RoundtableToolParams) => Promise<RoundtableToolResult>,
): void {
  for (const spec of BRIDGE_TOOLS) {
    registrar.registerTool(spec.name, { description: spec.description, inputSchema: spec.inputSchema }, async (args) => {
      const result = await execute(spec.toParams(args));
      // details are session-internal metadata; MCP peers get text + isError.
      return { content: result.content, isError: result.isError };
    });
  }
}
