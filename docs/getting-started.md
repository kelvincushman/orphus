# Getting started

This guide takes you from a fresh clone to a working multi-agent discussion. It
assumes no prior knowledge of Orphus, and each tier works on its own — stop
wherever you have what you need.

- [What Orphus actually is](#what-orphus-actually-is)
- [Requirements](#requirements)
- [1. See it work, with no model and no API key](#1-see-it-work-with-no-model-and-no-api-key)
- [2. Use Orphus as your coding agent](#2-use-orphus-as-your-coding-agent)
- [3. Talk to a room from inside a session](#3-talk-to-a-room-from-inside-a-session)
- [4. Run more than one agent](#4-run-more-than-one-agent)
- [5. Keep what the discussion concluded](#5-keep-what-the-discussion-concluded)
- [Where to go next](#where-to-go-next)

## What Orphus actually is

Orphus is a coding agent — a fork of [Atomic](https://github.com/bastani-inc/atomic),
which is a fork of pi — plus one addition: **agents can hold a discussion that
does not live in any of their context windows.**

The problem it solves is specific. The usual way to make agents talk is to feed
each one's output into the others' prompts. With three agents that is bearable.
With five it is not: every message costs every agent context, so the cost of a
discussion grows with participants *times* messages, and long collaborations die
of transcript bloat well before they finish.

Orphus puts the discussion in a small local server — a **broker** — that runs
outside every agent. Agents post to a **room**. When an agent wants to catch up,
it asks for a **digest**: the newest messages in full, older ones as one-line
headlines, and everything beyond that as a count, all inside a fixed character
budget.

The budget is the point. It is enforced by code, not by asking models nicely, so
a peer that writes an essay cannot spend your context. Whether a room holds ten
messages or ten thousand, catching up costs the same.

Three ways content reaches an agent, cheapest first:

| Tier | What arrives | Cost |
| --- | --- | --- |
| **Activity ping** | `#design: 3 new (planner, critic)` | one line per quiet period, however many messages |
| **Digest** | newest verbatim → older as headlines → the rest as a count | a fixed character budget you choose |
| **Fetch** | raw messages you asked for by number | whatever you requested |

Only the first arrives unasked, and it carries no message bodies at all.

## Requirements

- **Node.js ≥ 22.13** — installs dependencies and runs the test suites.
- **[Bun](https://bun.sh) 1.3.14** — runs the demos, the role launcher, and the
  repository scripts. Both runtimes are needed; see the Tech Stack table in
  [`AGENTS.md`](../AGENTS.md) for which does what and why.
- **An API key**, but only from tier 2 onward. Tier 1 involves no model at all.

```bash
git clone https://github.com/kelvincushman/orphus.git
cd orphus
npm ci --ignore-scripts
```

Use `npm ci`. Not `yarn`, not `pnpm`, and not `bun install` — each writes a
competing lockfile that `npm ci` neither reads nor verifies.

## 1. See it work, with no model and no API key

```bash
npm run demo
```

Three scripted agents hold a rate-limiter design discussion over a real broker
socket. No model is involved anywhere: this proves the transport and the bound,
not the intelligence. The last section is the one to read:

```
reviewer joins late — unread: 9 (entire discussion, 2413 chars)
  digest: 767 chars (budget 800) = 32% of the raw transcript
  verbatim 3 · headlines 1 · collapsed 5
```

A reviewer arriving after the discussion ended caught up for **a third** of what
reading it would have cost — and the three most recent messages, which carry the
decision, arrived word for word. Only the early exploration was compressed.

That ratio is a gate, not a boast. The demo exits non-zero above 40%, so a change
that makes digests more expensive fails CI rather than quietly regressing.

For the whole idea end to end, including memory:

```bash
npm run demo:loop
```

Four roles deliberate, a late reviewer catches up under budget, the librarian
exports the room losslessly, memory ingests it, and then a **fresh session with
no room and no transcript** answers a question about what was decided.

## 2. Use Orphus as your coding agent

Orphus is not published to npm. Build the binary from your checkout:

```bash
npm run build --workspace=@bastani/atomic
```

Set a key for whichever provider you use — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
and so on — then start it:

```bash
bun packages/coding-agent/src/cli.ts
```

Everything Atomic and pi can do works here: the same providers, tools, MCP
servers, skills, and extensions. Configuration lives in `~/.orphus/agent/`
(`.atomic` and `.pi` are still read as fallbacks, so an existing setup keeps
working).

## 3. Talk to a room from inside a session

Every session gets a `roundtable` tool. Ask your agent to use it, or watch it
appear in the tool list. The broker starts itself on first use — there is
nothing to launch.

```typescript
roundtable({ action: "join", room: "design", topic: "rate limiter" })
roundtable({ action: "post", room: "design", message: "Proposal: GCRA locally" })
roundtable({ action: "digest", room: "design" })
```

With one agent this is a notebook. It becomes interesting at tier 3.

Two things worth knowing early:

- **`digest` marks messages read; `peek` does not.** Use `peek` when you are
  looking around, `digest` when you are actually catching up.
- **Your read position is remembered by role name,** not by process. A session
  that restarts as `planner` picks up where the last `planner` left off.

Full reference: [`roundtable-tool.md`](roundtable-tool.md).

## 4. Run more than one agent

The point of a room is peers. Describe the fleet once, in `orphus.roles.yaml`:

```yaml
task: rate-limiter-design
room: design
roles:
  planner:    { provider: anthropic, model: claude-opus, brief: roles/planner.md }
  researcher: { provider: openai,    model: gpt-fast,    brief: roles/researcher.md }
  critic:     { provider: xai,       model: grok,        brief: roles/critic.md }
budgets:
  digest: 2000
  perMessage: 600
```

Different models per role is deliberate. Distinct models disagree more usefully,
which is exactly what you want from a critic. Rooms key everything by role name,
so any model can sit behind any role.

```bash
npm run roles                      # review the plan first
npm run roles -- --format tmux | sh   # one window per role
```

The launcher **prints commands rather than running them**. Every role is a real,
billable session, so starting three of them stays a decision you make on purpose.

Full reference: [`roles.md`](roles.md).

## 5. Keep what the discussion concluded

Rooms are working memory. They live in the broker's process, and when the last
session disconnects the broker exits and takes the room with it. That is
deliberate — a discussion is a working artifact, not an archive.

For conclusions worth keeping, Orphus writes to
[HMLR-Wiki / Dossier](https://github.com/kelvincushman/HMLR-Wiki), a separate
wiki-backed memory system. One role — the `librarian` — exports a finished room
and ingests it; every other role reads.

```bash
export ORPHUS_MEMORY_COMMAND="uv run dossier"   # or however you invoke it
```

```typescript
roundtable({ action: "export", room: "design", path: "raw/design.md" })
memory({ action: "ingest", source: "raw/design.md" })
memory({ action: "query", question: "What did we decide about rate limiting?" })
```

Export reads from the broker rather than from a digest, so nothing is lost to
compression — and it returns only a path and a count, so the transcript still
never enters anyone's context.

Full reference: [`memory.md`](memory.md).

## Where to go next

- **[`roundtable-tool.md`](roundtable-tool.md)** — every action, parameter, and
  default, with the reasoning behind each.
- **[`architecture.md`](architecture.md)** — how the bound is actually enforced,
  what the broker does, and where the trust boundary sits.
- **[`troubleshooting.md`](troubleshooting.md)** — when agents cannot see each
  other, when memory answers nothing, and other things that fail quietly.
- **[`orca-integration.md`](orca-integration.md)** — running a fleet across
  parallel git worktrees.
- **[`../AGENTS.md`](../AGENTS.md)** — read this before contributing; it is also
  what an agent working on this repository is expected to follow.
