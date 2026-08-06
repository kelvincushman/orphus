# Roundtable design

## Goal

Let N agent sessions deliberate without any session paying O(discussion) context
cost. The bound must be enforced by the runtime, not by prompt discipline.

## Architecture

```
┌──────────┐   post/digest    ┌────────────────────┐
│ session A │◄───────────────►│  roundtable broker  │
└──────────┘   (tool calls)   │  (unix socket /     │
┌──────────┐                  │   named pipe)       │
│ session B │◄───────────────►│                     │
└──────────┘  activity pings  │  RoomStore:         │
┌──────────┐   (1-liners)     │   rooms, ring       │
│ session C │◄───────────────►│   buffers, cursors  │
└──────────┘                  └────────────────────┘
```

- **Broker** (`broker/broker.ts`): one per machine per agent dir, auto-spawned
  detached on first tool use, exits 5s after the last session disconnects.
  Length-prefixed JSON framing, identical to intercom's.
- **RoomStore** (`broker/room-store.ts`): pure in-memory state — rooms, ring
  buffers (500 msgs/room), per-member-name read cursors. No sockets; unit-tested
  directly.
- **Client** (`broker/client.ts`): promise-based request/response with a small
  activity event stream.
- **Extension** (`index.ts`): registers the `roundtable` tool; coalesces
  activity pings (1.5s window) into ONE follow-up custom message; connects
  lazily on first tool use so idle sessions pay nothing.

## The context-window contract

Three delivery tiers, each with a hard bound:

| Tier | What enters context | Bound |
|---|---|---|
| Activity ping | "#design: 3 new (planner, critic)" | one line per quiet period |
| Digest | newest verbatim → headlines → collapsed count | `budget` chars (default 2000) |
| Explicit fetch | raw messages by seq range | caller-chosen limit |

`buildDigest` (digest.ts) is deterministic and model-free: budget is spent on
newest messages first, rendered chronologically. A hostile or verbose peer
cannot inflate another agent's context — oversized messages are capped with
truncation markers, overflow collapses to a count line.

## Decisions and trade-offs

- **Cursors keyed by member name, not session id** — sessions restart and
  reconnect; roles ("planner") persist. Cost: two sessions sharing a name share
  a cursor. Acceptable locally; revisit if rooms go cross-machine.
- **Separate broker from intercom** — intercom's broker carries supervisor
  capabilities and reply-waiting machinery with security invariants; a room
  server bolted into it would widen that attack surface. Shared framing keeps a
  later merge cheap.
- **No model-side summarization in v1** — the digest is extractive. A
  summarizer hook (cheap model compressing collapsed history on request) slots
  in behind `buildDigest` without protocol changes; kept out of v1 so the bound
  is provable.
- **Ephemeral rooms** — in-memory only. JSONL persistence under
  `~/.atomic/agent/roundtable/rooms/` is a straightforward follow-up if
  discussions must survive broker restarts.

## Security posture

Same trust model as intercom: local-machine, same-user sessions. The socket
lives under the agent dir with user-only permissions. Rooms carry no
capabilities — nothing a room message can do besides be read; the dangerous
verbs (spawning, supervising) stay in intercom.
