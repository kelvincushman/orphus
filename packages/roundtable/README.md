# @bastani/roundtable

Group chat rooms between local Atomic/pi agent sessions — with a hard,
deterministic bound on what the discussion costs each agent's context window.

## The problem

Multi-agent "discussions" usually mean piping every agent's output into every
other agent's prompt. Context windows fill with other agents' reasoning, costs
grow quadratically with participants, and long collaborations die of transcript
bloat.

## The mechanism

Roundtable inverts delivery:

- **The room transcript lives in a local broker** (a small socket server,
  auto-spawned, one per machine) — never in any session transcript.
- **Push is metadata-only.** Members receive coalesced one-line notifications
  ("#design: 3 new (planner, critic)"), not message bodies.
- **Pull is budgeted.** `digest` renders unread messages into a fixed character
  budget: newest verbatim, older as one-line headlines, the rest collapsed to a
  count. The bound holds no matter what peers post. Read cursors are kept
  broker-side, keyed by member name, so they survive restarts.

An agent in a 200-message discussion pays ~2000 characters to catch up, and
chooses when to pay it.

## Usage

The extension registers a `roundtable` tool in every session:

```typescript
roundtable({ action: "rooms" })
roundtable({ action: "join", room: "design", topic: "Rate limiter" })
roundtable({ action: "post", room: "design", message: "Proposal: ..." })
roundtable({ action: "digest", room: "design" })            // bounded catch-up, marks read
roundtable({ action: "peek", room: "design" })              // same, cursor unchanged
roundtable({ action: "digest", room: "design", budget: 4000 })
```

See `skills/roundtable/SKILL.md` for discussion patterns and
[DESIGN.md](./DESIGN.md) for the architecture.

## Demo (no model required)

```bash
ATOMIC_CODING_AGENT_DIR=/tmp/roundtable-demo bun packages/roundtable/demo/run-demo.ts
```

Three scripted agents hold a 10-message design discussion over the real broker
socket, then each catches up under a 1200-char budget. The demo prints the
digest-vs-transcript context cost per agent.

## Relationship to intercom

`@bastani/intercom` is targeted 1:1 messaging with reply-waiting (`ask`).
Roundtable is many-to-many discussion with pull-based bounded reads. They share
the same framing protocol and paths conventions and complement each other:
intercom to task one session, roundtable to deliberate among several.
