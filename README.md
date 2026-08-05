<h1 align="center">Orphus</h1>

<p align="center">
  <b>Bounded multi-agent discussion for agent harnesses.</b><br/>
  Agents deliberate like a team — without drowning in each other's words.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/runtime-Bun%20%7C%20Node%2022-black" alt="Bun or Node 22">
</p>

---

## The problem

Multi-agent "discussion" usually means piping every agent's output into every other
agent's prompt. Context windows fill with other agents' reasoning, token costs grow
quadratically with participants, and long collaborations die of transcript bloat.

## The Orphus answer: a context-window contract

The discussion lives in a small local broker — **outside every agent's context
window**. What enters an agent's context is bounded by the runtime, not by prompt
discipline:

| Tier | What enters context | Bound |
|---|---|---|
| **Activity ping** (push) | `#design: 3 new (planner, critic)` | one line per quiet period, coalesced |
| **Digest** (pull) | newest messages verbatim → older as one-line headlines → rest collapsed to a count | fixed character budget (default 2000) |
| **Explicit fetch** | raw messages by sequence range | caller-chosen |

The digest is deterministic and model-free: budget is spent on the newest messages
first, rendered chronologically. A verbose — or hostile — peer **cannot** inflate
your context. Read cursors live broker-side, keyed by role name, so they survive
session restarts.

```
┌──────────┐   post / digest   ┌─────────────────────┐
│ planner  │◄─────────────────►│    Orphus broker     │
├──────────┤   (tool calls)    │    (local socket)    │
│ critic   │◄─────────────────►│                      │
├──────────┤  activity pings   │  rooms · ring buffer │
│ reviewer │◄─────────────────►│  read cursors        │
└──────────┘   (one-liners)    └─────────────────────┘
```

**Measured:** in the bundled demo, a reviewer joining *after* a 9-message design
discussion catches up for **33% of the raw transcript cost** — with the decision
messages intact verbatim and only early exploration collapsed.

## Quickstart

```bash
git clone <this-repo> orphus && cd orphus
bun install
bun run demo        # scripted 3-agent discussion + late-joining reviewer, no model needed
bun run test        # 19 tests: digest bound, room store, real-socket integration
bun run typecheck
```

The demo runs three scripted agents (planner, researcher, critic) through a rate-limiter
design discussion over the real broker socket, then shows each agent — and a late-joining
reviewer — catching up under budget:

```
reviewer joins late — unread: 9 (entire discussion, 2413 chars)
  digest: 804 chars (budget 800) = 33% of the raw transcript
  verbatim 3 · headlines 1 · collapsed 5
```

No model is involved anywhere in the demo: it proves the transport and the bound.
Attach real agents for the live version (below).

## What's in the box

```
src/digest.ts            The budgeted digest algorithm (the core idea, ~130 lines)
src/broker/room-store.ts Room state: members, ring buffers, read cursors
src/broker/broker.ts     Local socket room server (auto-spawn, idle shutdown)
src/broker/client.ts     Promise-based client + tiny activity event stream
demo/run-demo.ts         The scripted discussion demo
test/                    Digest bound, room store, real-socket integration tests
integrations/atomic/     Extension + `roundtable` tool for Atomic-based harnesses
patches/atomic/          Ready-to-`git am` patch series for an Atomic fork
docs/                    Orca orchestration guide, self-improvement loop design
PLAN.md · DESIGN.md      Project plan and architecture decisions
```

## Using it from an agent (the `roundtable` tool)

Inside an [Atomic](https://github.com/bastani-inc/atomic) fork (see
`integrations/atomic/`), every session gets:

```typescript
roundtable({ action: "rooms" })                                // list rooms
roundtable({ action: "join", room: "design", topic: "…" })     // join / create
roundtable({ action: "post", room: "design", message: "…" })   // post
roundtable({ action: "digest", room: "design" })               // bounded catch-up, marks read
roundtable({ action: "peek", room: "design" })                 // same, cursor unchanged
roundtable({ action: "digest", room: "design", budget: 4000 }) // bigger budget when justified
```

Discussion etiquette for agents ships as a skill (`integrations/atomic/skills/`):
post conclusions not transcripts, digest before deciding, one room per concern.

## Install into an Atomic fork

```bash
cd your-atomic-fork
git am path/to/orphus/patches/atomic/0001-*.patch
bun install && bun run typecheck
```

The patch adds the full `packages/roundtable` package, 20 repo-root tests, and
tsconfig wiring. Verified against atomic `d84fc43`.

## Orchestrating a fleet with Orca

[Orca](https://github.com/stablyai/orca) runs CLI agents in parallel git worktrees —
same machine, which is exactly the broker's trust boundary. Give each worktree a role
name, point them all at the default agent dir, and prompt each to join the task room:

> "Join roundtable room #task-123. Deliberate with your peers. Post conclusions,
> digest before deciding."

Open any agent's transcript in Orca: a handful of one-line pings and small digests,
while the full deliberation lives in the room. That asymmetry is the point — and the
demo. Full guide: [docs/orca-integration.md](docs/orca-integration.md).

## Roadmap: the self-improving harness

Orphus's second act is a loop where the harness improves itself, gated by evidence
rather than self-report — retrospective agents deliberate in a room, propose diffs to
skills or harness code, an independent verifier derives checks from the design
contract and runs the tests, and a human gate merges. The bootstrap demonstration:
ask the loop to reduce digest cost at equal information, and review the diff with
before/after metrics attached.

Design: [docs/self-improvement-loop.md](docs/self-improvement-loop.md) · Plan and
phases: [PLAN.md](PLAN.md)

## Design decisions

Why cursors are keyed by role name, why the broker is separate from intercom's, why
there's no model-side summarization in v1 (so the bound stays provable), and the
security posture: [DESIGN.md](DESIGN.md).

## Lineage and thanks

Orphus builds on the shoulders of [Atomic](https://github.com/bastani-inc/atomic)
(MIT) — a fork of the Pi agent harness — whose `@bastani/intercom` package
(descended from [pi-intercom](https://github.com/nicobailon/pi-intercom)) proved
lazy, broker-based agent messaging on this runtime. Orphus extends the idea from
targeted 1:1 messaging to bounded many-to-many deliberation.

## License

MIT © Kelvin Lee. Wire framing and path conventions derived from Atomic (MIT).
