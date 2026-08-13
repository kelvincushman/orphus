# Roundtable MCP bridge — design

**Date:** 2026-08-09
**Status:** implemented (PR #38)

## Problem

Rooms are reachable only from inside an Orphus process. `packages/roundtable/index.ts`
is loaded as a builtin, so every Orphus session registers the `roundtable` and
`memory` tools without configuration — and nothing else can. The broker is a Unix
socket at `<agentDir>/roundtable/broker.sock` speaking a private framed protocol,
its only client is `broker/client.ts` inside the binary, and the only published bin
is `orphus-roles`, the launcher.

The consequence is a real limit on what a fleet can be. A room can hold any *model*
Orphus supports as a provider, but it cannot hold another *harness*.

## What already works, and is not this

Mixed-model roundtables need no new code. The harness supports `anthropic`,
`openai`, `openai-codex`, `openrouter`, `github-copilot`, `kimi-coding`, `radius`,
and `xai` as providers, and `orphus.roles.yaml` is explicitly model-agnostic —
"rooms key cursors and attribution by role name, so any model can sit behind any
role. Mixing families is the point." A planner on Claude Opus, a researcher on
Codex, and a critic on Kimi is a manifest edit and `npm run roles`.

This design does not improve that. It addresses the different case: **Claude Code,
Gemini CLI, and Cursor are not providers.** They are complete agent loops with
their own context management, skills, and tools, and Orphus cannot host them behind
`--provider`. The bridge is what lets a real Claude Code session sit in a room next
to an Orphus-hosted Kimi role.

## Approach

A stdio MCP server that speaks to the existing broker as an ordinary client.

Rejected alternatives:

- **A thin `orphus-room` CLI.** Widest reach — any agent that can run a shell
  command could join, including ones without MCP. Rejected because MCP-capable
  hosts get real tool schemas and native tool-calling, which is how the target
  clients (Claude Code, Codex, Gemini CLI, Cursor) are actually driven. A CLI
  would make every call a shell round-trip the model has to format by hand.
- **Both surfaces.** Two things to keep in sync for one capability. Revisit only
  if a wanted peer has no MCP support.

## Components

### Entry point

`packages/roundtable/bin/orphus-roundtable-mcp.ts`, declared as a second bin on
`@orphus/roundtable` alongside `orphus-roles`. Not a new package: it is the same
contribution, ships with the same builtin, and reuses `broker/client.ts` and
`broker/framing.ts` rather than reimplementing the wire protocol.

### SDK

`@modelcontextprotocol/server@2.0.0` with `serveStdio` from
`@modelcontextprotocol/server/stdio`, targeting the **2026-07-28** specification.

That spec retired the `initialize`/`initialized` handshake — each request now
carries its protocol version and client identity in `_meta` — and SDK v2 replaced
the monolithic `@modelcontextprotocol/sdk` with focused `@modelcontextprotocol/server`
and `client` packages. Both went stable on 2026-07-27.

Zod 4.4.3 is already installed and satisfies the SDK's `zod ^4.2.0` dependency, so
this adds no schema library. `@orphus/mcp` stays on SDK 1.30.0 (`2025-11-25`);
the package names differ, so the two coexist without conflict.

### Identity

The role is pinned at startup by `--as <role>` and stamped on every broker call.
The tool schemas carry no role parameter.

This mirrors how the roles launcher injects identity today, via
`--append-system-prompt`. It matters because room cursors and attribution are keyed
by role name: a model-supplied role would let a typo silently fork a new cursor, and
would let one peer post under another's name. One server process per role.

### Tools

Eight tools, one per broker action, each with its own zod schema:

| tool | arguments |
| --- | --- |
| `roundtable_rooms` | — |
| `roundtable_join` | `room` |
| `roundtable_leave` | `room` |
| `roundtable_post` | `room`, `message` |
| `roundtable_digest` | `room`, `budget?` |
| `roundtable_peek` | `room`, `limit?` |
| `roundtable_export` | `room`, `path` |
| `roundtable_fetch` | `room`, `afterSeq?`, `limit?` |

Separate tools rather than one tool with an `action` discriminator: the model sees
exactly which arguments each action takes, and the SDK validates before the handler
runs, so a wrong argument fails at the protocol layer instead of inside a union.

`roundtable_export` returns a whole transcript, which is the context blow-up rooms
exist to prevent. It is exposed for parity, and its description says so — a peer
should reach for `roundtable_digest` and only export when it genuinely needs the
raw record.

### Broker lifecycle

The builtin spawns the broker lazily on first use. If every peer is external, no
Orphus session exists to do that, so the server ensures the broker itself on first
call, via the existing `ensureBrokerRunning()` in `broker/spawn.ts`.

Connection stays lazy for the same reason it is lazy in the extension: a server
that is configured but never called should cost nothing.

### Trust boundary

Unchanged. `packages/roundtable/DESIGN.md`: "local-machine, same-user sessions. The
socket lives under the agent dir with user-only permissions. Rooms carry no
capabilities — nothing a room message can do besides be read; the dangerous verbs
(spawning, supervising) stay in intercom."

A stdio MCP server launched by the same user on the same machine sits inside that
boundary rather than widening it. It opens no port, and adds no verb the builtin
tool does not already have.

## Error handling

- **Broker unreachable after an ensure attempt** — return an MCP tool error naming
  the socket path. Do not retry in a loop; a peer that cannot reach the broker
  should say so rather than hang.
- **Malformed frame** — the existing client already destroys the connection on a
  bad frame, on the principle that once framing is untrustworthy everything behind
  it is suspect. The server surfaces that as a tool error and reconnects on the
  next call.
- **Unknown room on `post`** — pass the broker's own error through unchanged rather
  than inventing a message.
- **Request timeout** — the client already has one; surface it verbatim.

## Testing

Unit, in `test/unit/roundtable-mcp-*.test.ts` to match the existing naming that
`ci.yml` selects with `vitest --run --project unit test/unit/roundtable-`:

- Each tool maps to the right broker request, with the pinned role stamped on and
  not taken from arguments.
- A role cannot be overridden through tool arguments.
- Schema rejection: a missing required argument fails before the handler runs.
- Broker-unreachable produces a tool error naming the socket, not a hang.
- Lazy connect: constructing the server opens no socket until the first call.

Integration, one scenario over the real broker and a real server process: two
peers with different pinned roles join a room, both post, and each pulls a digest
that attributes messages to the correct role.

The no-model demos stay the proof of the digest contract; this adds no model calls.

## Out of scope

- The `memory` tool. The librarian writer convention is a coordination check
  designed around Orphus sessions; extending it across foreign harnesses is its
  own design.
- Remote or cross-machine peers. The trust boundary is same-user, same-machine,
  and nothing here changes that.
- An `orphus-room` shell CLI. Revisit if a wanted peer has no MCP support.
- Changing the roles launcher. Mixed-model fleets already work through providers.

## Definition of done

Per AGENTS.md: `docs/roles.md` and `docs/architecture.md` gain the external-peer
path; `docs/README.md` indexes it; the README states how to point an MCP client at
a room; `packages/coding-agent/CHANGELOG.md` gets an `Added` entry under `[Unreleased]`
(the roundtable package has no changelog; its user-visible entries live in the
shipping package's), because this is user-visible shipped behaviour rather than
infrastructure.
