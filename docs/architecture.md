# Architecture

How the context-window bound is actually enforced, what runs where, and which
guarantees are real versus conventional. For the design rationale behind these
choices — the alternatives considered and rejected — see
[`../packages/roundtable/DESIGN.md`](../packages/roundtable/DESIGN.md).

- [The shape of it](#the-shape-of-it)
- [The broker](#the-broker)
- [The wire](#the-wire)
- [The extension](#the-extension)
- [What the bound guarantees](#what-the-bound-guarantees)
- [Trust boundary](#trust-boundary)
- [Failure modes worth knowing](#failure-modes-worth-knowing)
- [Where Orphus ends and Atomic begins](#where-orphus-ends-and-atomic-begins)

## The shape of it

```
┌──────────┐   post / digest   ┌─────────────────────┐
│ planner  │◄─────────────────►│    Orphus broker    │
├──────────┤   (tool calls)    │   (local socket)    │
│ critic   │◄─────────────────►│                     │
├──────────┤  activity pings   │  rooms · ring buffer│
│ reviewer │◄─────────────────►│  read cursors       │
└──────────┘   (one-liners)    └─────────────────────┘
```

Each agent is an ordinary Orphus session. The broker is a separate process
holding all room state. Nothing about the discussion is replicated into a
session's transcript except what that session explicitly pulls.

The asymmetry is the product: open any agent's transcript during a live
discussion and you find a handful of one-line pings and a few small digests,
while the room holds the whole deliberation.

## The broker

A single-process room server on a local socket under the agent directory
(`~/.orphus/agent/roundtable/broker.sock`, or a named pipe on Windows). One per
agent directory.

**It starts itself.** The first session to use the tool spawns a detached
broker. There is no daemon to install and no start command in any workflow.

**It exits when idle** — five seconds after the last session disconnects. Rooms
are in-memory, so they go with it. Only a broker that owns its own process may
exit it; one embedded in a test or a demo shuts down without taking its host
down, which is a distinction the code makes explicitly.

**Startup resolves contention through the socket, not a lock file.** Several
sessions starting at once — the normal case for `orphus-roles --format tmux | sh`
— all try to spawn. Before reclaiming a socket path, a broker checks whether
something is already answering on it. If so it stands down; if the path is
stale, it reclaims it. The residual race, where two brokers probe in the same
instant, resolves at `listen()` when the loser gets `EADDRINUSE`.

The pid file is diagnostic only, and deliberately not the lock: pids are reused,
and a lock file cannot say whether its holder is still *serving*. The socket
answers exactly that question, so the socket is the lock.

**Room state** is a ring buffer of 500 messages per room, plus members and a
cursor per role name. Sequence numbers are monotonic per room and never reused,
which is what makes `afterSeq` stable across rotation.

## The wire

Length-prefixed JSON: a 4-byte big-endian length, then the payload. The framing
deliberately mirrors `@bastani/intercom`'s so the two brokers stay
protocol-cousins and a future merge stays cheap.

The reader buffers across socket reads, so a message split arbitrarily — even
with its length header arriving in pieces — reassembles correctly. A malformed
payload stops the batch rather than skipping to the next message: once framing
is untrustworthy, everything behind it is suspect, and the broker destroys that
connection.

## The extension

`packages/roundtable/index.ts` is loaded as a builtin, so every session
registers `roundtable` and `memory` without configuration.

**The connection is lazy.** A session that never touches a room never connects
and never spawns a broker — an idle session pays nothing. Concurrent first calls
are serialized behind a single in-flight promise, because the harness runs tools
in parallel and two simultaneous calls would otherwise create two clients, one
orphaned and still firing events.

**Pings are coalesced** over a 1.5-second window: counts and author names per
room, one message per quiet period, no bodies. Events carrying sequence zero are
membership churn and are filtered out before they can be mistaken for content.

## What the bound guarantees

Precisely, so you know what you can rely on:

**Guaranteed.** A digest is at most `budget` characters plus one marker line.
This holds regardless of how many messages are unread, how long they are, or who
wrote them. The digest algorithm is deterministic and model-free, so the same
inputs always produce the same output, and no peer can influence the size of
yours by writing differently.

**Guaranteed.** Push delivery carries no message bodies. What arrives unasked is
a count and a set of author names.

**Not guaranteed.** That a digest contains what you needed. Budget is spent
newest-first, so conclusions survive and early exploration compresses — but if
the important thing is old, it will be a headline or a count. The collapse
marker tells you how many were dropped; `fetch` gets them back.

**Not a bound at all.** `fetch` returns what you ask for, in full. That tier
exists because the caller sometimes genuinely needs the text, and a small default
page size is the only guard.

## Trust boundary

**Local machine, same user.** The socket lives under the agent directory with
user-only permissions. Every session that can open it already runs as you, with
your permissions.

So a hostile same-user process is outside the model: it has a shell and does not
need the broker. What *is* in scope is anything that escapes the boundary — a
change that widens the socket beyond the local user, or a path by which a peer
could inflate your context past the digest bound.

Two things that look like security boundaries and are not:

- **The `librarian` write role** is a coordination convention. It is an
  in-process check on a role name, and it prevents *accidental* concurrent
  writes to shared memory, which is the real failure it exists to stop. Any
  same-user session could invoke the memory backend directly, so no in-process
  check could make it enforcement.
- **Prompt injection in a room message** is ordinary untrusted content. Room
  messages carry no capabilities — nothing a message can do except be read — and
  the dangerous verbs (spawning, supervising) live in intercom, not here.

Reporting: [`../SECURITY.md`](../SECURITY.md).

## Failure modes worth knowing

Two of these fail *silently*, which is why they are worth reading before you hit
them.

**Split fleet.** Sessions resolving different agent directories reach different
brokers and cannot see each other — with no error, because each is talking to a
perfectly healthy broker of its own. Symptom: peers post and nobody's unread
count moves. Fix: one `ORPHUS_CODING_AGENT_DIR` across the fleet.

**Empty memory store.** A memory query against a store nothing was ingested into
returns an empty answer and exits zero, which reads as success. `ORPHUS_MEMORY_DIR`
now defaults under the agent home specifically so worktrees converge without
configuration.

**Lost membership after a broker restart.** The broker exits five seconds after
the last session leaves. A session outliving it reconnects to a *new* broker
with no rooms, and the next post fails with `Not a member of room "…"; join it
first`. This one is loud and the message is the remedy. Replaying joins
automatically would be worse — it would restore the appearance of continuity
over a transcript that no longer exists.

**A role name that changes.** Cursors key on role name, so a session without a
stable `--name` falls back to `session-<pid>` and loses its read position on
every restart.

## Where Orphus ends and Atomic begins

Most of this repository is vendored upstream. What Orphus authors:

| Path | What it is |
| --- | --- |
| `packages/roundtable/` | Rooms, digest, broker, roles, memory adapter — everything above |
| `test/unit/roundtable-*` | Its tests |
| `docs/`, `roles/`, `orphus.roles.yaml` | This documentation and the example manifest |
| `.github/workflows/ci.yml` | The gate that actually runs |

Everything else — the agent loop, providers, tools, MCP, subagents, workflows,
the TUI — comes from [Atomic](https://github.com/bastani-inc/atomic) and behaves
as it does upstream. A bug there is usually worth reporting upstream too.

The inherited `test.yml`, `publish.yml`, and `warm-toolchain-cache.yml` are all
**disabled**: they target Blacksmith runners registered to the upstream
organization, which never pick up jobs here. `publish.yml` and
`warm-toolchain-cache.yml` are kept byte-identical to upstream; `test.yml` is
not, because it carries the rebrand's `ORPHUS_REQUIRE_*` env-var names. Read
them as a record of upstream's topology, not as this repository's CI. What runs
here is documented in [`ci.md`](ci.md).
