# Orphus — Project Plan

*A self-improving agent harness for bounded multi-agent discussion. Fork of [bastani-inc/atomic](https://github.com/bastani-inc/atomic) (itself a Pi harness fork), orchestrated by [stablyai/orca](https://github.com/stablyai/orca).*

## The one-liner

Agents that deliberate like a team without drowning in each other's words. The discussion lives in a runtime broker outside every agent's context window; each agent pays only a fixed, budgeted digest to catch up — and the harness uses its own verification machinery to improve itself.

## Why fork Atomic (findings from the codebase)

Atomic already has the bones Orphus needs, which changes the plan from "build" to "extend":

- **`@bastani/intercom`** — 1:1 messaging between local agent sessions via a unix-socket broker, lazy-loaded so idle sessions pay zero context. This is the transport pattern to build on, not replace.
- **`@bastani/workflows`** — typed execution graphs with author/verifier separation and adversarial-verification builtins. This is the self-improvement engine, already written.
- **Verification-first runtime** — stages declare schema-checked outputs; completion is decided by code, not model self-report. Exactly the gate a self-modifying system needs.
- **Orca compatibility** — Orca ships a Pi integration (`src/main/pi/`) that Atomic remains compatible with, so Orphus sessions can run as Orca worktree agents with minimal adapter work.

What Atomic does *not* have: many-to-many discussion. Intercom is targeted 1:1; its README points at group chat as an explicit gap. That gap is Orphus's core contribution.

## Architecture: the context-window contract

The central design idea — and the thesis of the book:

```
┌──────────┐   post / digest   ┌─────────────────────┐
│ planner  │◄─────────────────►│   Orphus broker      │
├──────────┤   (tool calls)    │   (local socket)     │
│ critic   │◄─────────────────►│                      │
├──────────┤  activity pings   │  rooms · ring buffer │
│ reviewer │◄─────────────────►│  read cursors        │
└──────────┘   (one-liners)    └─────────────────────┘
```

Three delivery tiers, each with a hard bound enforced by the runtime, not by prompt discipline:

| Tier | What enters an agent's context | Bound |
|---|---|---|
| Activity ping | `#design: 3 new (planner, critic)` | one line per quiet period (coalesced) |
| Digest (pull) | newest messages verbatim → older as headlines → rest collapsed to a count | fixed char budget (default ~2000) |
| Explicit fetch | raw messages by sequence range | caller-chosen |

Key properties: digests are deterministic and model-free (a verbose or hostile peer cannot inflate your context); read cursors live broker-side keyed by role name, so they survive session restarts; the full transcript is always available but never *imposed*.

**Validated:** before the plan-only instruction arrived I had a working proof-of-concept of exactly this running in the sandbox against the real Atomic codebase — broker, client, tool, and demo; strict typecheck clean; 20 tests passing including real-socket integration. In the demo, a late-joining reviewer catches up on a 9-message design discussion for **33% of the raw transcript cost**, with decision messages intact verbatim. The mechanism works; it's parked as staged changes you can take or leave.

## Phases

### Phase 1 — Orphus rooms (the multi-agent chat)

Fork Atomic → rename/brand as Orphus. Add a `rooms` package (broker, client, `roundtable`-style tool with `join / post / digest / peek`, extension with coalesced notifications, skill file teaching discussion patterns). Ship a no-model demo: scripted agents deliberating over the real socket, printing digest-vs-transcript cost. Exit criteria: strict typecheck, unit + socket-integration tests, demo metric under 40% for a late joiner.

### Phase 2 — Orca orchestration

Run 3–5 Orphus sessions as Orca worktree agents sharing one broker (same machine = same trust boundary, so this needs configuration, not code): shared agent dir, role names per worktree (`planner`, `researcher`, `critic`), a room per task (`#orca-task-123`). Demo choreography: fan one prompt across worktrees in Orca, open any agent's transcript, show it contains only pings and small digests while the room holds the full deliberation. Exit criteria: a screen-recordable live demo.

**Landed: the role manifest and launcher.** `orphus.roles.yaml` declares task, room, per-role provider/model/brief, and digest budgets; `orphus-roles` turns it into launch commands in five formats (`plan`, `json`, `sh`, `tmux`, `orca`). It emits rather than spawns — every role is a billable session, so the fan-out stays explicit, and the whole path stays deterministic and testable without a model. 32 tests cover parsing, validation, plan construction, shell quoting, and the CLI; the tmux fan-out is verified end to end against a stub binary. See [docs/roles.md](docs/roles.md).

Two things the implementation pinned down that the sketch had wrong: the session-name flag is `--name` (not `--session-name`), and it is load-bearing — the roundtable extension reads `pi.getSessionName()` for room identity and silently falls back to `session-<pid>`, costing the role its broker-side cursor. `--append-system-prompt` also treats a non-existent path as literal prompt text, so a typo'd brief becomes the system prompt; the manifest loader checks brief existence up front.

Still open for the live demo: real Orca worktrees driven end to end with models attached, and the screen recording.

### Phase 3 — The self-improvement loop

Two axes, both gated by evidence, never self-report:

- **Axis 1, skills/prompts (continuous, low risk):** after each workflow run, retrospective agents join `#retro-<runId>`, deliberate over the run's evidence (verifier verdicts, repair counts), and propose diffs to skills and prompt files. Proposals are verified by Atomic's builtin adversarial-verification workflow against skill evals, then human-gated.
- **Axis 2, harness code (gated, high risk):** same loop targeting the Orphus repo itself. The proposing agent never verifies itself — a fresh-context verifier derives checks from the design contract (e.g. "digest never exceeds budget + one marker line") and runs the test suite. Mechanical rubric: typecheck + tests + file:line-evidenced review. Human approval merges.
- **Bootstrap demonstration that closes the loop:** ask the improvement workflow to reduce digest cost at equal information; it edits the digest algorithm, reruns tests and demo, reports before/after metrics; you review the diff with metrics attached. Each accepted iteration is a chapter artifact.

Exit criteria: one accepted self-authored improvement to skills, and one to harness code, with full evidence trails.

### Phase 4 — Book and public demo

The book writes itself from the evidence trail — every chapter anchored to a diff, a metric, or a transcript:

1. Why context windows kill multi-agent systems (the quadratic problem)
2. Anatomy of a harness (Pi → Atomic → Orphus lineage)
3. The context-window contract (tiers, bounds, digest algorithm)
4. Deliberation patterns (planner/critic/reviewer; when 1:1 intercom beats a room)
5. Orchestrating fleets with Orca (worktrees, roles, demo choreography)
6. The self-improvement loop (author/verifier separation, gates, the bootstrap)
7. Evidence, not vibes (what the metrics actually showed, including failures)

Demo assets: the live Orca fan-out, the no-model scripted demo (works offline on stage), and the before/after self-improvement diff.

## Risks and open questions

- **Upstream drift** — Atomic moves fast (12k+ files). Mitigation: keep Orphus additions in self-contained packages sharing only the framing protocol; rebase regularly.
- **Digest quality vs bound** — extractive digests are provably bounded but can bury nuance. A model-side summarizer hook can slot in behind the digest function later; keeping it out of v1 keeps the bound provable (and the book argument clean).
- **Self-modification safety** — Axis 2 must never merge without the human gate; the gate is code, and the gate's code is itself only changeable by hand. Worth stating in the book as a design principle.
- **Naming** — "Orphus" the fork; decide whether the rooms package keeps a separate name (currently `roundtable` in the prototype) or becomes `@orphus/rooms`.
- **Orca upstream** — if the Pi-compat path feels brittle, contributing a first-class Orphus adapter to Orca (`src/main/orphus/`) is the durable route.

## Success metrics

- Late-joiner digest ≤ 40% of raw transcript cost with decisions intact (prototype: 33%)
- N-agent discussion: each agent's context grows O(digests pulled), not O(messages posted)
- One self-authored, human-approved improvement in each axis with evidence trail
- A demo runnable offline in under 3 minutes

## What exists already (take it or leave it)

Staged in the sandbox clone of Atomic: the rooms package (~1,100 lines: broker, client, digest algorithm, tool, extension, skill), 20 passing tests, the scripted demo, and drafts of `DESIGN.md`, `orca-integration.md`, and `self-improvement-loop.md`. It validates Phase 1 end-to-end. Say the word and I'll export it as patches for your Orphus fork — or archive it and we refine this plan first.
