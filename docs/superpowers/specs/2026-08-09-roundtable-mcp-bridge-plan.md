# Roundtable MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let external MCP-capable agent CLIs (Claude Code, Codex, Gemini CLI, Cursor) join roundtable rooms as first-class peers, via a stdio MCP server with a pinned role.

**Architecture:** A new `orphus-roundtable-mcp` bin on `@orphus/roundtable` wraps the *existing* `createRoundtableTool` — the entire action logic (all 8 actions, export path validation, digest budgeting, error texts) is reused, not reimplemented. The bridge supplies the tool's `deps` with a role pinned at startup, exposes each action as a separate MCP tool with a zod schema, and ensures the broker with the existing `ensureBrokerRunning()`.

**Tech Stack:** `@modelcontextprotocol/server` 2.0.0 (2026-07-28 stateless spec, `serveStdio`), zod 4.4.3 (already installed), the existing `broker/client.ts` + `broker/spawn.ts`, vitest with `node:assert/strict`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-roundtable-mcp-bridge-design.md` (this plan corrects two of its assumptions; see Task 6).
- Install with `npm install --workspace=…` ONLY — never yarn/pnpm/bun install (AGENTS.md; `.npmrc` has `save-exact` + 2-day release-age gate; `@modelcontextprotocol/server@2.0.0` published 2026-07-27, well past the gate).
- Companion packages ship raw TypeScript: NO build step, NO `dist/`, `.js` import extensions in source (resolved to `.ts` by the loaders).
- Tests: vitest, assertions via `node:assert/strict`, hooks `beforeAll`/`afterAll` (not `before`/`after`). Unit tests must be named `test/unit/roundtable-*.test.ts` so `ci.yml`'s `npx vitest --run --project unit test/unit/roundtable-` selects them.
- No restated default timeouts; an explicit timeout only for structural cost, as a NAMED constant at the call site (AGENTS.md per-test timeout policy).
- Test helpers from `test/helpers/runtime.ts` (`bunExecutable`, `spawnProcess`, `moduleDir`, `decodeStream`) — never raw `Bun.*` or `process.execPath` for spawning Bun.
- Role identity: pinned at startup via `--as`; NO tool schema may accept a role. Role names must match `NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i` (`roles/manifest.ts:20`).
- Commits authored as `Kelvin Lee <kelvin.cushman@gmail.com>`, no AI trailers. One concern per PR — this whole plan is one PR.
- `npm run check` green before every commit (pre-commit hook enforces it plus `test:unit`).

**Key existing interfaces (verified against source, consume as-is):**

```ts
// packages/roundtable/broker/client.ts
class RoundtableClient {
  constructor(readonly name: string, socketPath?: string)   // `name` IS the attribution identity
  async connect(): Promise<void>
  disconnect(): void
  get connected(): boolean
  async listRooms(): Promise<RoomInfo[]>
  async join(room: string, topic?: string): Promise<{ room: RoomInfo; cursor: number }>
  async leave(room: string): Promise<void>
  async post(room: string, text: string, replyTo?: string): Promise<RoomMessage>
  async fetch(room: string, afterSeq: number, limit?: number): Promise<{ messages: RoomMessage[]; lastSeq: number; cursor: number }>
  async setCursor(room: string, seq: number): Promise<number>
}

// packages/roundtable/broker/spawn.ts
export async function ensureBrokerRunning(socketPath?: string): Promise<void>  // spawns detached broker, waits, throws "Roundtable broker did not start in time"

// packages/roundtable/broker/paths.ts
export function getBrokerSocketPath(env?: NodeJS.ProcessEnv): string  // <agentDir>/roundtable/broker.sock; agentDir honors ORPHUS_CODING_AGENT_DIR

// packages/roundtable/roundtable-tool.ts
export interface RoundtableToolDeps {
  ensureConnected(): Promise<RoundtableClient>;
  exportRoot: string;
  currentRole(): string | undefined;
  writerRole: string;
}
export type RoundtableToolParams = { action: "rooms"|"join"|"leave"|"post"|"digest"|"peek"|"fetch"|"export";
  path?: string; room?: string; message?: string; replyTo?: string; topic?: string;
  budget?: number; perMessage?: number; afterSeq?: number; limit?: number };
export interface RoundtableToolResult { isError: boolean; content: Array<{ type: "text"; text: string }>; details: RoundtableToolDetails }
export function createRoundtableTool(deps: RoundtableToolDeps): {
  name: "roundtable";
  execute(toolCallId: string, params: RoundtableToolParams, signal: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<RoundtableToolResult>;
  /* …description, parameters… */
}

// packages/roundtable/memory/dossier.ts
export function resolveMemoryConfig(env?: NodeJS.ProcessEnv): { cwd: string; writerRole: string; /* command */ }
```

---

### Task 1: Add the MCP v2 SDK dependencies and pin the real API surface

**Files:**
- Modify: `packages/roundtable/package.json` (dependency added by npm)
- Modify: `package.json` + `package-lock.json` (root devDependency, lockfile)
- Modify: `packages/coding-agent/npm-shrinkwrap.json` (regenerated)

**Interfaces:**
- Consumes: npm workspaces, `scripts/generate-coding-agent-shrinkwrap.mjs`.
- Produces: importable `@modelcontextprotocol/server` (runtime dep of `@orphus/roundtable`) and `@modelcontextprotocol/client` (root devDep, tests only). A note of the EXACT export names for Tasks 4–5.

- [ ] **Step 1: Install the server SDK into the roundtable workspace and the client SDK as a root devDependency**

```bash
cd /Volumes/ExtHdd/Projects/dev/Orphus/orphus
npm install @modelcontextprotocol/server --workspace=@orphus/roundtable
npm install --save-dev @modelcontextprotocol/client
```

- [ ] **Step 2: Regenerate the published shrinkwrap (the check fails otherwise)**

```bash
node scripts/generate-coding-agent-shrinkwrap.mjs
```

- [ ] **Step 3: Pin the actual v2 API names before writing any code against them**

The v2 docs say `McpServer`, `registerTool`, and `serveStdio` from `@modelcontextprotocol/server/stdio`, but the SDK went stable twelve days ago — verify rather than trust:

```bash
node -e "import('@modelcontextprotocol/server').then(m => console.log('server:', Object.keys(m).join(', ')))"
node -e "import('@modelcontextprotocol/server/stdio').then(m => console.log('stdio:', Object.keys(m).join(', ')))"
node -e "import('@modelcontextprotocol/client').then(m => console.log('client:', Object.keys(m).join(', ')))"
ls node_modules/@modelcontextprotocol/server/README.md && sed -n '1,80p' node_modules/@modelcontextprotocol/server/README.md
```

Record the confirmed names. If they differ from `McpServer` / `registerTool` / `serveStdio`, use the confirmed names in Tasks 4–5 — the structure of those tasks does not change, only the identifiers.

- [ ] **Step 4: Verify the gate passes with the new lockfile state**

Run: `npm run check`
Expected: biome, tsc, and `check:shrinkwrap` all pass ("npm-shrinkwrap.json is up to date").

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/roundtable/package.json packages/coding-agent/npm-shrinkwrap.json
git commit -m "deps(roundtable): add MCP v2 server SDK, client SDK for tests"
```

---

### Task 2: Bridge deps — lazy broker connection with a pinned role

**Files:**
- Create: `packages/roundtable/mcp/bridge-deps.ts`
- Test: `test/unit/roundtable-mcp-bridge-deps.test.ts`

**Interfaces:**
- Consumes: `RoundtableClient`, `ensureBrokerRunning`, `getBrokerSocketPath`, `resolveMemoryConfig`, `RoundtableToolDeps` (all listed in Global Constraints).
- Produces: `createBridgeDeps(role: string, overrides?: BridgeOverrides): BridgeDeps` where `BridgeDeps extends RoundtableToolDeps { disconnect(): void }` and `BridgeOverrides = { ensureBroker?: () => Promise<void>; makeClient?: (role: string) => RoundtableClient }`. Task 4 calls `createRoundtableTool(createBridgeDeps(role))`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/roundtable-mcp-bridge-deps.test.ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { createBridgeDeps } from "../../packages/roundtable/mcp/bridge-deps.js";
import type { RoundtableClient } from "../../packages/roundtable/broker/client.js";

/** Minimal client stand-in: records construction and connects instantly. */
function fakeClientFactory(log: string[]) {
  return (role: string): RoundtableClient => {
    log.push(`make:${role}`);
    let connected = false;
    return {
      name: role,
      get connected() {
        return connected;
      },
      connect: async () => {
        log.push(`connect:${role}`);
        connected = true;
      },
      disconnect: () => {
        log.push(`disconnect:${role}`);
        connected = false;
      },
    } as unknown as RoundtableClient;
  };
}

test("construction is lazy: no broker ensure and no client until the first call", () => {
  const log: string[] = [];
  createBridgeDeps("critic", {
    ensureBroker: async () => {
      log.push("ensure");
    },
    makeClient: fakeClientFactory(log),
  });
  assert.deepEqual(log, []);
});

test("first call ensures the broker, then connects a client named after the pinned role", async () => {
  const log: string[] = [];
  const deps = createBridgeDeps("critic", {
    ensureBroker: async () => {
      log.push("ensure");
    },
    makeClient: fakeClientFactory(log),
  });
  const client = await deps.ensureConnected();
  assert.equal(client.name, "critic");
  assert.deepEqual(log, ["ensure", "make:critic", "connect:critic"]);
});

test("concurrent first calls share one in-flight connection", async () => {
  const log: string[] = [];
  const deps = createBridgeDeps("critic", {
    ensureBroker: async () => {
      log.push("ensure");
    },
    makeClient: fakeClientFactory(log),
  });
  const [a, b] = await Promise.all([deps.ensureConnected(), deps.ensureConnected()]);
  assert.equal(a, b);
  assert.deepEqual(log, ["ensure", "make:critic", "connect:critic"]);
});

test("currentRole returns the pinned role, always", () => {
  const deps = createBridgeDeps("critic", {
    ensureBroker: async () => {},
    makeClient: fakeClientFactory([]),
  });
  assert.equal(deps.currentRole(), "critic");
});

test("a broker-ensure failure names the socket path", async () => {
  const deps = createBridgeDeps("critic", {
    ensureBroker: async () => {
      throw new Error("Roundtable broker did not start in time");
    },
    makeClient: fakeClientFactory([]),
  });
  await assert.rejects(deps.ensureConnected(), (error: Error) => {
    assert.match(error.message, /did not start in time/u);
    assert.match(error.message, /broker\.sock/u);
    return true;
  });
});

test("disconnect drops the client so the next call reconnects", async () => {
  const log: string[] = [];
  const deps = createBridgeDeps("critic", {
    ensureBroker: async () => {
      log.push("ensure");
    },
    makeClient: fakeClientFactory(log),
  });
  await deps.ensureConnected();
  deps.disconnect();
  await deps.ensureConnected();
  assert.deepEqual(log, ["ensure", "make:critic", "connect:critic", "disconnect:critic", "ensure", "make:critic", "connect:critic"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest --run --project unit test/unit/roundtable-mcp-bridge-deps.test.ts`
Expected: FAIL — cannot resolve `../../packages/roundtable/mcp/bridge-deps.js`.

- [ ] **Step 3: Implement**

```ts
// packages/roundtable/mcp/bridge-deps.ts
import { RoundtableClient } from "../broker/client.js";
import { getBrokerSocketPath } from "../broker/paths.js";
import { ensureBrokerRunning } from "../broker/spawn.js";
import { resolveMemoryConfig } from "../memory/dossier.js";
import type { RoundtableToolDeps } from "../roundtable-tool.js";

export interface BridgeOverrides {
  ensureBroker?: () => Promise<void>;
  makeClient?: (role: string) => RoundtableClient;
}

export interface BridgeDeps extends RoundtableToolDeps {
  disconnect(): void;
}

/**
 * The builtin's deps come from a live session (`pi.getSessionName()`); the
 * bridge has no session, so the role is pinned at construction and stamped on
 * everything. Connection stays lazy for the same reason it is lazy in the
 * extension: a server that is configured but never called must cost nothing.
 * Unlike the builtin, the bridge must also ensure the broker exists — when
 * every peer is external, no Orphus session is around to spawn it.
 */
export function createBridgeDeps(role: string, overrides: BridgeOverrides = {}): BridgeDeps {
  const ensureBroker = overrides.ensureBroker ?? (() => ensureBrokerRunning());
  const makeClient = overrides.makeClient ?? ((name: string) => new RoundtableClient(name));
  const memoryConfig = resolveMemoryConfig();
  let client: RoundtableClient | null = null;
  let connecting: Promise<RoundtableClient> | null = null;

  const ensureConnected = (): Promise<RoundtableClient> => {
    if (client?.connected) return Promise.resolve(client);
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        try {
          await ensureBroker();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A peer that cannot reach the broker should say where it looked.
          throw new Error(`${message} (socket: ${getBrokerSocketPath()})`);
        }
        const fresh = makeClient(role);
        await fresh.connect();
        client = fresh;
        return fresh;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    ensureConnected,
    exportRoot: memoryConfig.cwd,
    currentRole: () => role,
    writerRole: memoryConfig.writerRole,
    disconnect: () => {
      client?.disconnect();
      client = null;
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest --run --project unit test/unit/roundtable-mcp-bridge-deps.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Check and commit**

```bash
npm run check
git add packages/roundtable/mcp/bridge-deps.ts test/unit/roundtable-mcp-bridge-deps.test.ts
git commit -m "feat(roundtable): bridge deps with pinned role and lazy broker connect"
```

---

### Task 3: Tool mapping — eight MCP tools onto the one shared execute

**Files:**
- Create: `packages/roundtable/mcp/register-tools.ts`
- Test: `test/unit/roundtable-mcp-register-tools.test.ts`

**Interfaces:**
- Consumes: `RoundtableToolParams`, `RoundtableToolResult` types.
- Produces:
  - `interface ToolRegistrar { registerTool(name: string, config: { description: string; inputSchema: Record<string, unknown> }, handler: (args: Record<string, unknown>) => Promise<BridgeToolResult>): void }`
  - `interface BridgeToolResult { content: Array<{ type: "text"; text: string }>; isError: boolean }`
  - `registerBridgeTools(registrar: ToolRegistrar, execute: (params: RoundtableToolParams) => Promise<RoundtableToolResult>): void`
  - `const BRIDGE_TOOL_NAMES: readonly string[]` (the 8 names, for the integration test's tools/list assertion)

  The registrar is a structural subset of the SDK's `McpServer`, so unit tests need no SDK and the bin passes the real server straight in.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/roundtable-mcp-register-tools.test.ts
import assert from "node:assert/strict";
import { test } from "vitest";
import type { RoundtableToolParams, RoundtableToolResult } from "../../packages/roundtable/roundtable-tool.js";
import {
  BRIDGE_TOOL_NAMES,
  registerBridgeTools,
  type ToolRegistrar,
} from "../../packages/roundtable/mcp/register-tools.js";

interface Registered {
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>;
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest --run --project unit test/unit/roundtable-mcp-register-tools.test.ts`
Expected: FAIL — cannot resolve `register-tools.js`.

- [ ] **Step 3: Implement**

```ts
// packages/roundtable/mcp/register-tools.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest --run --project unit test/unit/roundtable-mcp-register-tools.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Check and commit**

```bash
npm run check
git add packages/roundtable/mcp/register-tools.ts test/unit/roundtable-mcp-register-tools.test.ts
git commit -m "feat(roundtable): map the eight roundtable actions onto MCP tools"
```

---

### Task 4: The `orphus-roundtable-mcp` bin

**Files:**
- Create: `packages/roundtable/mcp/cli.ts`
- Create: `packages/roundtable/bin/orphus-roundtable-mcp.ts`
- Modify: `packages/roundtable/roles/manifest.ts:20` (export `NAME_PATTERN` — add the `export` keyword, nothing else)
- Modify: `packages/roundtable/package.json` (second `bin` entry)
- Test: `test/unit/roundtable-mcp-cli.test.ts`

**Interfaces:**
- Consumes: `createBridgeDeps` (Task 2), `registerBridgeTools` (Task 3), `createRoundtableTool`, `NAME_PATTERN`, SDK names confirmed in Task 1 Step 3.
- Produces: `parseBridgeArgs(argv: string[]): { role: string } | { error: string }`, and a runnable bin. The integration test (Task 5) spawns `packages/roundtable/bin/orphus-roundtable-mcp.ts` with `--as <role>`.

- [ ] **Step 1: Write the failing tests for argument parsing**

```ts
// test/unit/roundtable-mcp-cli.test.ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { parseBridgeArgs } from "../../packages/roundtable/mcp/cli.js";

test("requires --as with a value", () => {
  assert.deepEqual("error" in parseBridgeArgs([]), true);
  assert.deepEqual("error" in parseBridgeArgs(["--as"]), true);
});

test("accepts a well-formed role", () => {
  assert.deepEqual(parseBridgeArgs(["--as", "critic"]), { role: "critic" });
  assert.deepEqual(parseBridgeArgs(["--as", "code-reviewer_2"]), { role: "code-reviewer_2" });
});

test("rejects a role the manifest would reject — cursors are keyed by it", () => {
  for (const bad of ["has space", "", "  ", "-leading", "naïve"]) {
    const parsed = parseBridgeArgs(["--as", bad]);
    assert.ok("error" in parsed, `expected rejection for ${JSON.stringify(bad)}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest --run --project unit test/unit/roundtable-mcp-cli.test.ts`
Expected: FAIL — cannot resolve `cli.js`.

- [ ] **Step 3: Export NAME_PATTERN and implement the parser**

In `packages/roundtable/roles/manifest.ts` line 20, change `const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;` to `export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;`. Touch nothing else in that file.

```ts
// packages/roundtable/mcp/cli.ts
import { NAME_PATTERN } from "../roles/manifest.js";

export const BRIDGE_USAGE = "Usage: orphus-roundtable-mcp --as <role>";

/**
 * The role is the peer's identity: room cursors and attribution are keyed by
 * it broker-side, which is why it is a launch flag rather than a tool
 * parameter, and why it must satisfy the same pattern the roles manifest
 * enforces.
 */
export function parseBridgeArgs(argv: string[]): { role: string } | { error: string } {
  const index = argv.indexOf("--as");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) return { error: BRIDGE_USAGE };
  const role = value.trim();
  if (!NAME_PATTERN.test(role)) {
    return { error: `Invalid role ${JSON.stringify(value)}: must match ${String(NAME_PATTERN)}. ${BRIDGE_USAGE}` };
  }
  return { role };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest --run --project unit test/unit/roundtable-mcp-cli.test.ts`
Expected: 3 passed. Also run `npx vitest --run --project unit test/unit/roundtable-` — the manifest export must not break any existing roles test.

- [ ] **Step 5: Write the bin**

Use the SDK identifiers confirmed in Task 1 Step 3. With the documented v2 names:

```ts
#!/usr/bin/env bun
// packages/roundtable/bin/orphus-roundtable-mcp.ts
//
// Stdio MCP server that lets an external agent CLI join roundtable rooms as a
// peer. Identity is pinned by --as at launch; see mcp/cli.ts for why.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBridgeDeps } from "../mcp/bridge-deps.js";
import { parseBridgeArgs } from "../mcp/cli.js";
import { registerBridgeTools } from "../mcp/register-tools.js";
import { createRoundtableTool } from "../roundtable-tool.js";

const parsed = parseBridgeArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(parsed.error);
  process.exit(2);
}

const deps = createBridgeDeps(parsed.role);
const tool = createRoundtableTool(deps);
const server = new McpServer({ name: "orphus-roundtable", version: "0.0.0" });
registerBridgeTools(server, (params) => tool.execute("mcp-bridge", params, new AbortController().signal, undefined, undefined));

process.on("exit", () => deps.disconnect());
await serveStdio(server);
```

If Task 1 recorded different identifiers (for example a factory instead of a class, or a different `serveStdio` call shape), use those — the deps/tool/register wiring above is fixed regardless.

- [ ] **Step 6: Declare the bin**

In `packages/roundtable/package.json`, extend the `bin` map:

```json
  "bin": {
    "orphus-roles": "bin/orphus-roles.ts",
    "orphus-roundtable-mcp": "bin/orphus-roundtable-mcp.ts"
  }
```

- [ ] **Step 7: Smoke the bin's failure mode by hand (no broker, bad args)**

```bash
bun packages/roundtable/bin/orphus-roundtable-mcp.ts 2>&1; echo "exit=$?"
```
Expected: prints the usage line, `exit=2`.

- [ ] **Step 8: Check and commit**

```bash
npm run check
git add packages/roundtable/mcp/cli.ts packages/roundtable/bin/orphus-roundtable-mcp.ts packages/roundtable/roles/manifest.ts packages/roundtable/package.json test/unit/roundtable-mcp-cli.test.ts
git commit -m "feat(roundtable): orphus-roundtable-mcp stdio server with pinned role"
```

---

### Task 5: Integration — two external peers deliberate over the real broker

**Files:**
- Test: `test/integration/roundtable-mcp-two-peers.test.ts`

**Interfaces:**
- Consumes: the bin (Task 4), `BRIDGE_TOOL_NAMES` (Task 3), `@modelcontextprotocol/client` (Task 1), `test/helpers/runtime.ts` (`bunExecutable`, `moduleDir`).
- Produces: nothing downstream; this is the end-to-end proof.

- [ ] **Step 1: Write the test**

Nothing mocked: real bin processes over stdio, a real broker spawned by the first bridge call, isolated from the user's broker by pointing `ORPHUS_CODING_AGENT_DIR` at a temp dir (the socket path derives from it). Use the client-side identifiers confirmed in Task 1 Step 3; with the documented v2 names:

```ts
// test/integration/roundtable-mcp-two-peers.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

    await critic.callTool({
      name: "roundtable_post",
      arguments: { room: "bridge-test", message: "Agreed, given the reconciliation window." },
    });

    // The critic's digest must attribute the planner's message to "planner" —
    // attribution comes from the pinned role, not from anything the model sent.
    const criticDigest = await critic.callTool({ name: "roundtable_digest", arguments: { room: "bridge-test" } });
    assert.match(textOf(criticDigest), /planner#\d+.*GCRA/u);

    const plannerDigest = await planner.callTool({ name: "roundtable_digest", arguments: { room: "bridge-test" } });
    assert.match(textOf(plannerDigest), /critic#\d+.*Agreed/u);

    // A digest consumed the unread state: a second digest has nothing new.
    const second = await critic.callTool({ name: "roundtable_digest", arguments: { room: "bridge-test" } });
    assert.match(textOf(second), /0 unread|No new messages/u);
  },
  REAL_MCP_BRIDGE_SCENARIO_TIMEOUT_MS,
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest --run --project integration test/integration/roundtable-mcp-two-peers.test.ts`
Expected: 1 passed. If it fails on client identifiers, reconcile against Task 1 Step 3's recorded names — the scenario itself does not change.

- [ ] **Step 3: Verify no broker leaked**

```bash
ls /tmp/orphus-mcp-bridge-* 2>/dev/null; echo "leftover dirs above (blank = clean)"
pgrep -f "broker/main.ts" | head -3; echo "(broker pids above — any still running were spawned detached; kill them and note whether the test's afterAll should)"
```
The broker exits when idle (`exitWhenIdle: true` in `broker/main.ts`), so expect no long-lived process. If one lingers, that is a finding to report, not to hide.

- [ ] **Step 4: Check and commit**

```bash
npm run check
git add test/integration/roundtable-mcp-two-peers.test.ts
git commit -m "test(roundtable): two MCP peers deliberate over the real broker"
```

---

### Task 6: Docs, changelog, and spec corrections

**Files:**
- Modify: `docs/roundtable-tool.md` (new "External peers over MCP" section)
- Modify: `docs/architecture.md` (the extension section gains the second client path)
- Modify: `README.md` (how to point an MCP client at a room)
- Modify: `packages/coding-agent/CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `docs/superpowers/specs/2026-08-09-roundtable-mcp-bridge-design.md` (two corrections)

**Interfaces:**
- Consumes: the shipped behavior of Tasks 1–5.
- Produces: documentation a user can follow cold.

- [ ] **Step 1: docs/roundtable-tool.md — add the external-peer section**

Add after the existing action reference (adjust the anchor to the file's structure):

```markdown
## External peers over MCP

Any MCP-capable agent CLI can join a room as a peer via the stdio server:

    bun packages/roundtable/bin/orphus-roundtable-mcp.ts --as critic

Point the client at it — for example in a `.mcp.json`:

    {
      "mcpServers": {
        "orphus-roundtable": {
          "command": "bun",
          "args": ["/path/to/orphus/packages/roundtable/bin/orphus-roundtable-mcp.ts", "--as", "critic"]
        }
      }
    }

The peer sees eight tools (`roundtable_rooms`, `roundtable_join`, `roundtable_leave`,
`roundtable_post`, `roundtable_digest`, `roundtable_peek`, `roundtable_fetch`,
`roundtable_export`) mirroring the builtin tool's actions. Three things differ from
an Orphus session:

- **Identity is pinned.** `--as` fixes the role at launch; no tool accepts a role,
  so a peer cannot typo its own cursor or post as another role. One server process
  per role.
- **The server ensures the broker.** An all-external fleet has no Orphus session to
  spawn it lazily, so the first tool call does.
- **No activity pushes.** Orphus sessions get coalesced activity one-liners; MCP has
  no equivalent channel, so peers poll with `roundtable_digest` (or `roundtable_peek`
  to look without consuming unread state).

The trust boundary is unchanged: same machine, same user, user-only socket
permissions. `roundtable_export` remains gated to the memory writer role.
```

- [ ] **Step 2: docs/architecture.md — extend "The extension" section**

After the paragraph on lazy connection, add:

```markdown
The builtin is no longer the only client. `orphus-roundtable-mcp` (in
`packages/roundtable/bin/`) is a stdio MCP server wrapping the same tool logic
and the same broker client, so external agent CLIs — Claude Code, Codex,
Gemini CLI — can sit in a room next to Orphus-hosted roles. It pins its role at
launch (`--as`), ensures the broker itself since no session will, and has no
push channel, so external peers poll digests. See
[the tool reference](roundtable-tool.md#external-peers-over-mcp).
```

- [ ] **Step 3: README.md — add a short subsection after "Using it from an agent"**

```markdown
### From another harness (MCP)

Rooms are not Orphus-only. `orphus-roundtable-mcp` is a stdio MCP server any
MCP-capable CLI can launch — Claude Code, Codex, Gemini CLI, Cursor — joining a
room as a peer with a pinned role:

    bun packages/roundtable/bin/orphus-roundtable-mcp.ts --as critic

Mixed-model fleets do not need this: the role manifest is model-agnostic, and
`npm run roles` already launches roles on any configured provider. The bridge is
for the case providers cannot cover — a whole other agent harness, with its own
tools and context management, sitting in the discussion. Details:
[docs/roundtable-tool.md](docs/roundtable-tool.md#external-peers-over-mcp).
```

- [ ] **Step 4: Changelog**

In `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`, append to (or create) `### Added` — read the section first and append, never duplicate the heading:

```markdown
- Added `orphus-roundtable-mcp`, a stdio MCP server (2026-07-28 protocol) that lets external MCP-capable agent CLIs join roundtable rooms as peers. The role is pinned at launch with `--as` and stamped on every post, the eight room actions are exposed as individually-schema'd tools, and the server spawns the room broker on first use so an all-external fleet needs no Orphus session running.
```

- [ ] **Step 5: Correct the spec**

In `docs/superpowers/specs/2026-08-09-roundtable-mcp-bridge-design.md`:
1. In "Broker lifecycle", replace the sentence naming `socket-probe.ts` and `broker/main.ts` with: "the server ensures the broker itself on first call, via the existing `ensureBrokerRunning()` in `broker/spawn.ts`."
2. In "Definition of done", replace `packages/roundtable/CHANGELOG.md` with `packages/coding-agent/CHANGELOG.md` and add "(the roundtable package has no changelog; its user-visible entries live in the shipping package's)".

- [ ] **Step 6: Check and commit**

```bash
npm run check
git add docs/roundtable-tool.md docs/architecture.md README.md packages/coding-agent/CHANGELOG.md docs/superpowers/specs/2026-08-09-roundtable-mcp-bridge-design.md
git commit -m "docs(roundtable): document external MCP peers, changelog the bridge"
```

---

### Task 7: Full verification and PR

**Files:** none new.

- [ ] **Step 1: The full local gate, with output captured**

```bash
npm run check
npx vitest --run --project unit test/unit/roundtable-
npm run test:integration
npm run demo
```
Expected: all green; demo prints ~32% and exits 0. Record actual counts for the PR body.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/roundtable-mcp-bridge
```

PR body must include: the spec path, what was reused (`createRoundtableTool`, `broker/client.ts`, `ensureBrokerRunning`) versus added, the two spec corrections, the verification outputs from Step 1, and a note that CodeRabbit's path filters cover `packages/roundtable/**` so this PR gets a real automated review. Squash-merge after the review gate.

---

## Self-review

- **Spec coverage:** entry point + bin (Task 4), SDK/v2 (Task 1), identity pinning (Tasks 2, 4), eight tools with per-tool schemas (Task 3), export parity + warning description (Task 3), broker lifecycle (Task 2), error handling — socket-path naming (Task 2), broker error passthrough (reused `roundtable-tool.ts` unchanged), timeout (existing client) — unit tests incl. lazy connect and no-role-override (Tasks 2–4), two-peer integration with attribution (Task 5), docs/README/changelog (Task 6). Out-of-scope items (memory tool, remote peers, shell CLI, roles-launcher changes) have no tasks, as specified.
- **Placeholders:** none; the only conditional steps are reconciling SDK identifier names against Task 1 Step 3's recorded output, with the surrounding structure fixed.
- **Type consistency:** `createBridgeDeps(role, overrides?) → BridgeDeps`; `registerBridgeTools(registrar, execute)`; `BRIDGE_TOOL_NAMES`; `parseBridgeArgs(argv) → {role}|{error}` — names match across Tasks 2–5.
