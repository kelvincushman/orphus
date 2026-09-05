<div align="center">
<img src="docs/assets/orphus-wordmark.svg" alt="ORPHUS" width="720">

<details>
<summary>Plain-text wordmark fallback</summary>
<pre>
  ####  #####  #####  #   # #   #  ####
 #    # #    # #    # #   # #   # #
 #    # #####  #####  ##### #   #  ####
 #    # #   #  #      #   # #   #      #
  ####  #    # #      #   #  ###   ####
</pre>
</details>
</div>

<h1 align="center">Orphus</h1>

<p align="center">
  <b>Many minds, from many makers, argue at one table — the best path leaves the room.</b><br/>
  Fleets of agents across providers deliberate in rooms outside their context windows,
  and converge on a decision of record.
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
window**. A room reaches an agent through three tiers, and the two it arrives
through *unasked* are bounded by the runtime rather than by prompt discipline:

| Tier | What enters context | Bound |
|---|---|---|
| **Activity ping** (push) | `#design: 3 new (planner, critic)` | one line per quiet period, coalesced |
| **Digest** (pull) | newest messages verbatim → older as one-line headlines → rest collapsed to a count | fixed character budget (default 2000) |
| **Explicit fetch** (pull) | raw messages by sequence range | **none** — full bodies, `limit` is the only guard |

`fetch` is deliberately not bounded: that tier exists for the caller who genuinely
needs the text, and truncating it silently would be the wrong failure. It is a
choice to spend context, which is different from context arriving whether you
wanted it or not.

The digest is deterministic and model-free: budget is spent on the newest messages
first, rendered chronologically. A verbose — or hostile — peer **cannot** inflate
your context. Read cursors live broker-side, keyed by role name, so they survive
session restarts.

That guarantee is specific, and worth not overstating. The room was the first
boundary bounded this way; **three now are**, through the same tiering core:
the room digest, a parallel subagent's return, and a chain step's `{outputs.name}`
splice. The two subagent rows carry a real qualifier — they bound by pointing at
an artifact file, so with artifacts disabled there is nowhere to point and
nothing is bounded rather than content being dropped. What is still *not*
bounded: a **single or chain subagent return** is truncated at 200 KB / 5000
lines and nothing more. An oversized **tool result** spills to a file above a
threshold, and an execution **kernel** bounds its buffer in memory while relying
on that same spill for context.

The honest scoreboard — with the constant behind each row and every qualifier
spelled out — is in
[docs/architecture.md](docs/architecture.md#boundaries-and-their-bounds).
`npm run evals:baseline` measures the tool-result row — what an oversized result
costs before and after the runtime substitutes a file reference — and CI fails if
that number regresses. The other rows have no such measurement yet.

Two loops built on this contract have their own pages:
[`docs/refine.md`](docs/refine.md) for gated, reversible self-modification, and
[`docs/repl.md`](docs/repl.md) for kernels — which are **not a security
sandbox**, and say so at the top.

For substantial verifiable build/change/fix/refactor work, Orphus routes
through native Goal rather than treating completion discipline as an optional
skill. Goal freezes a
depth-tree plan before implementation, validates disjoint `OWNS`/`Needs` scopes,
runs 3..24 leaves with up to 10 ready leaves in flight, verifies every leaf with
exact per-check evidence, and uses three decorrelated final reviewers plus a
reducer before it calls the work complete. Tiny deterministic answers,
read-only checks, handoff tasks, and direct low-risk edits can still stay
inline; the core promise is fewer false finishes, not literal infallibility when
tools, providers, checks, or external authority are missing.

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
discussion catches up for **32% of the raw transcript cost** — with the decision
messages intact verbatim and only early exploration collapsed.

## Documentation

| | |
| --- | --- |
| **[Getting started](docs/getting-started.md)** | Clone to working fleet, in five tiers. The first needs no model and no API key. |
| **[The `roundtable` tool](docs/roundtable-tool.md)** | Every action, parameter, and default, with the reasoning. |
| **[Architecture](docs/architecture.md)** | What runs where, and what the bound actually guarantees. |
| **[Harness](packages/coding-agent/docs/harness.md)** | The capability boundary, the provider/tool session records, and `orphus inspect runtime`. |
| **[Browser operation](packages/coding-agent/docs/browser.md)** | Driving an isolated browser, available by default with a separately gated login path. |
| **[Goal workflows](packages/coding-agent/docs/workflows.md#goal-as-the-core-completion-loop)** | The native plan/fan-out/verify/review loop Orphus uses for substantial coding tasks. |
| **[Transcription](packages/coding-agent/docs/transcribe.md)** | Local dictation: the protocol, the model catalog, and why it is not enabled yet. |
| **[Terminal backend](packages/coding-agent/docs/tui-backend.md)** | The termDOM pilot for startup selection and the session picker. Opt-in; pi stays the default. |
| **[Troubleshooting](docs/troubleshooting.md)** | The three failures that look like success. |
| **[All documentation](docs/README.md)** | Roles, memory, Orca, CI, design decisions. |

## Requirements

Everyone needs these two:

| | Version | Why |
|---|---|---|
| **Node** | ≥ 22.19 | Runs the agent and every test suite |
| **Bun** | ≥ 1.3.14 | Runs the demo, the role launcher, `scripts/*.ts`; compiles release binaries |

**Install dependencies with `npm` only.** `package-lock.json` is the single lockfile, and the
committed `.npmrc` adds a supply-chain gate (`save-exact`, `min-release-age=2`). `pnpm`, `yarn`,
and `bun install` each write a competing lockfile that `npm ci` neither reads nor verifies, and
bypass that gate — so they are not merely discouraged, they are wrong here. npm is the task
runner; Bun is the interpreter the tasks call. See [AGENTS.md](AGENTS.md).

Each tier below adds only its own extras. Stop at whichever one you need.

## Tier 1 — Run the demo (no model, no keys)

```bash
git clone https://github.com/kelvincushman/orphus.git orphus && cd orphus
npm ci --ignore-scripts
npm run demo        # scripted 3-agent discussion + late-joining reviewer
npm run demo:loop   # the full loop: room → export → memory → later recall
npm run roles       # the role manifest, turned into launch commands
```

`demo:loop` is the whole thesis in one run: four roles deliberate, a late reviewer
catches up on a bounded digest, the librarian exports the room losslessly, memory ingests
it behind the role gate, and a **fresh session with no access to the room** recalls the
decision. No model, no API key. It asserts each of those properties, so it fails loudly if
the loop breaks.

Nothing else required — no API key, no network. This is the fastest way to see the
context-window contract actually hold.

## Tier 2 — Use Orphus as your agent

The fastest path on macOS arm64 or Linux x64 glibc is the release installer — no toolchain,
no clone. It downloads the newest release archive, verifies its checksum, and links `orphus`
into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/kelvincushman/orphus/main/install.sh | sh
orphus
```

`install.sh --help` documents pinning a version (`--ref v2.1.0`) and the
`ORPHUS_INSTALL_DIR` / `ORPHUS_BIN_DIR` overrides. Add an **API key** for whichever provider
you use, or log in from inside a session with `/login`.

From then on, `orphus update` upgrades in place: it checks this repository's releases,
re-runs the installer, and flips the `current` pointer — the previous version stays on
disk for rollback (older ones are pruned). Nobody reinstalls by hand. Updates follow your channel: a stable install tracks
stable releases only, so it is never dragged onto a beta; a prerelease install tracks the
newest release of any kind.

### Windows x64

Windows x64 is distributed as a portable ZIP for now. Download
`orphus-windows-x64.zip` and `SHA256SUMS` from the
[latest release](https://github.com/kelvincushman/orphus/releases/latest), then verify and
extract it in PowerShell:

```powershell
$checksum = Get-Content .\SHA256SUMS |
  Where-Object { $_ -match 'orphus-windows-x64\.zip$' } |
  Select-Object -First 1
if (-not $checksum) { throw "Windows checksum not found" }
$expected = $checksum.Split()[0].ToLowerInvariant()
$actual = (Get-FileHash .\orphus-windows-x64.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checksum mismatch" }
Expand-Archive .\orphus-windows-x64.zip -DestinationPath . -Force
.\orphus\orphus.exe
```

The Windows ZIP does not yet have managed installation or in-place self-update; replace the
extracted folder when a newer release is published.

### Building from a clone instead

Adds: a **Rust toolchain** ([rustup](https://rustup.rs)) for the native bindings, and an
**API key** for whichever provider you use.

```bash
npm run build --workspace=@orphus/natives   # native bindings (needs Rust)
npm run build --workspace=@orphus/coding-agent           # builds dist/cli.js
export ANTHROPIC_API_KEY=...                        # or GEMINI_API_KEY, OPENAI_API_KEY, …
node packages/coding-agent/dist/cli.js --provider anthropic --model claude-opus
```

The package declares an `orphus` bin, but it is only on your `PATH` after a global install or
`npm link`; from a clone, run `dist/cli.js` directly as above. To skip the build while
developing, `bun packages/coding-agent/src/cli.ts` runs the same CLI from source.

Credentials can also be set from inside a session with `/login`. Provider and model names are
in [packages/coding-agent/docs/models.md](packages/coding-agent/docs/models.md); every
supported key is listed in
[docs/environment-variables.md](packages/coding-agent/docs/environment-variables.md).

Rooms and memory arrive automatically — `packages/roundtable` is a builtin package, so every
session gets the `roundtable` and `memory` tools with no extra install.

To see what a session actually resolved to — the model, the tools and their schema hashes,
the extensions and the order their hooks run in, flag and settings provenance, and the
system-prompt section hashes — ask the binary rather than reading the wiring:

```bash
orphus inspect runtime --json
```

It dispatches nothing, its output is deterministic (so a diff between two runs is a real
difference), and secrets are redacted. Sessions also record the exact body of every provider
request and what came back — see
[harness.md](packages/coding-agent/docs/harness.md).

Skills extend from there: `orphus install <git-url>` consumes community skill packs
([mattpocock/skills](https://github.com/mattpocock/skills) for engineering workflow,
[cli-printing-press](https://github.com/mvanhorn/cli-printing-press) to mint agent-native
CLIs from any API), and new skills follow the writing-for-agents method — see
[skills.md](packages/coding-agent/docs/skills.md).

## Tier 3 — Run a fleet

Adds: **[Orca](https://github.com/stablyai/orca)** for worktree fan-out, or **tmux** for a
local one-window-per-role fan-out.

```bash
npm run roles -- --format tmux | sh    # one tmux window per role
npm run roles -- --format orca | sh    # one Orca terminal per role
```

All roles share one broker automatically because they resolve the same agent dir. See
[docs/roles.md](docs/roles.md) and [docs/orca-integration.md](docs/orca-integration.md).

## Tier 4 — Enable long-term memory

Adds: **Python** and [HMLR-Wiki / Dossier](https://github.com/kelvincushman/HMLR-Wiki),
installed separately (it is not vendored here).

```bash
export ORPHUS_MEMORY_COMMAND="python -m dossier"   # default; use an absolute path for a venv
node packages/coding-agent/dist/cli.js --name librarian   # the one role allowed to write
```

The wiki lives at `<agent dir>/memory` by default, so every session and Orca worktree shares
one memory. Contract and configuration: [docs/memory.md](docs/memory.md).

## How Orphus works

Orphus is the runtime: a fork of [Atomic](https://github.com/bastani-inc/atomic), which is
itself a fork of Pi, so it works with the providers, tools, MCP servers, skills, and
extensions already in your Pi stack. Workflows encode durable processes through stages,
tools, prompts, checks, artifacts, gates, and approvals. Skills supply reusable expert
instructions. Specialized subagents handle focused work while a parent agent or workflow
controls the larger task. Rooms — the part that is ours — hold the discussion *between*
those agents, outside their context windows.

## Live worker visibility

Orphus now treats visible orchestration as part of the product, not a hidden debug
feature. Interactive Goal runs automatically open the existing workflow graph, where
you can see every stage and worker, its status, model, elapsed time, and dependencies.
Use the arrow keys to select a worker, press Enter to attach to its live session, and
press F2 to hide or return to the graph.

Background subagents also appear in a below-editor panel branded as
`ORPHUS HARNESS · workers live`. Parallel lanes are shown as `Worker N/M` with status,
model/thinking labels, and current activity; expanded views add recent tools, output,
and available counters. Press `Ctrl+O` (or your configured `app.tools.expand` binding)
to expand the panel while work is still in flight.

The shape is deliberately small: it borrows the useful part of Fusion Harness-style
operator visibility — clear live lanes and evidence that every worker is moving —
without importing a separate footer, process runner, or second orchestration framework.

<!-- Kept on one line: test/unit/execution-routing-guidance.test.ts asserts these phrases
     verbatim against this file, and a wrapped line breaks the literal match. -->
Workflow stage dependencies must form a directed acyclic graph. Because imperative `workflow({ run })` definitions materialize topology from runtime branches, loops, and nested calls, module discovery cannot prove arbitrary acyclicity. Cyclic workflow graphs are unsupported: authored loop and repair iterations must create distinct tracked work per iteration and must never create self-edges or back-edges to ancestors. Retries within one `ctx.tool(...)` call remain attempts on that tool node rather than separate graph work.

## What's in the box

```
packages/roundtable/          The Orphus contribution — rooms and the context-window contract
  digest.ts                     The budgeted digest algorithm (the core idea, ~130 lines)
  broker/room-store.ts          Room state: members, ring buffers, read cursors
  broker/broker.ts              Local socket room server (auto-spawn, idle shutdown)
  broker/client.ts              Promise-based client + tiny activity event stream
  roles/                        Role manifest → launch plan (parse, plan, format, CLI)
  bin/orphus-roles.ts           The launcher entrypoint
  roundtable-tool.ts, index.ts  The `roundtable` tool and extension
  memory-tool.ts, memory/       The `memory` tool → HMLR-Wiki/Dossier (docs/memory.md)
  demo/run-demo.ts              The scripted discussion demo
  skills/                       Discussion etiquette, shipped as an agent skill
packages/fleet/               Fleet blueprints: /fleet, /fleetsetup, the fleet tool, SCHEMA.md,
                                six examples, and the orchestration + kie-ai-media skills
packages/coding-agent/        The `orphus` binary (Atomic-derived, plus the first-party
                                harness boundary, browser operation, and termDOM backend)
packages/transcribe/          Local dictation, derived from pi-transcribe — protocol, model
                                catalog, ABI pin. Not bundled: fails closed until natives exist
packages/{workflows,subagents,intercom,mcp,web-access,natives}
orphus.roles.yaml · roles/    Example role manifest and briefs — copy-me templates
test/unit/roundtable-*        Rooms, memory, socket, digest, broker lifecycle, and role-launcher tests
patches/atomic/               The 0001–0004 series, as applied to upstream `d84fc43`
docs/                         Getting started, tool reference, architecture, troubleshooting,
                                roles, memory, Orca, CI (start at docs/README.md)
archive/upstream/             Atomic's inherited working notes — nothing reads them
.github/workflows/ci.yml      The gate that runs; release.yml builds the binary on a v* tag
PLAN.md · AGENTS.md · packages/roundtable/DESIGN.md
```

## Using it from an agent (the `roundtable` tool)

Every session in this runtime gets:

```typescript
roundtable({ action: "rooms" })                                 // rooms, with YOUR unread count
roundtable({ action: "join", room: "design", topic: "…" })      // join / create
roundtable({ action: "post", room: "design", message: "…" })    // post
roundtable({ action: "digest", room: "design" })                // bounded catch-up, marks read
roundtable({ action: "peek", room: "design" })                  // same, cursor unchanged
roundtable({ action: "fetch", room: "design", afterSeq: 12 })   // raw messages, no digest
roundtable({ action: "export", room: "design", path: "raw/…" }) // lossless, for memory ingest
roundtable({ action: "leave", room: "design" })                 // leave
```

Digests take `budget` (total characters) and `perMessage` (how hard each body is
truncated). Lowering `perMessage` fits more messages into the same budget — the
better lever when you want the shape of a discussion rather than exact wording.

When a digest reports collapsed messages, `fetch` that range rather than raising
the budget: it costs less and does not re-pay for everything newer you have
already read. Full reference: [docs/roundtable-tool.md](docs/roundtable-tool.md).

Discussion etiquette for agents ships as a skill
(`packages/roundtable/skills/`): post conclusions not transcripts, digest before
deciding, one room per concern.

## Declaring a roundtable (`orphus.roles.yaml`)

Deliberation improves when roles run on different models — distinct models
disagree more usefully, which is exactly what you want from a critic. Rooms key
everything by role name, so any model can sit behind any role. Declare the fleet
once:

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

```bash
npm run roles                             # review the plan
npm run roles -- --format tmux | sh       # fan out locally, one window per role
npm run roles -- --format orca | sh       # fan out across Orca worktrees
npm run roles -- --format json            # for your own orchestrator
```

(The package also installs an `orphus-roles` binary; from a clone, `npm run
roles` is the invocation that works without a global install.)

Each role launches with its own model, its brief, and a generated coordination
footer naming its role and room. The launcher emits commands rather than
spawning them — every role is a real, billable session, so the fan-out stays an
explicit act. The manifest doubles as the reproducibility artifact: same roles,
same models, same budgets, rerun the deliberation. Full reference:
[docs/roles.md](docs/roles.md).

## Relationship to Atomic

This repository *is* the Orphus runtime — you do not need to apply anything to get it. The
tree is Atomic at `d84fc43` plus four commits, and `patches/atomic/` keeps that delta as a
standalone series for anyone who would rather add rooms to their own Atomic checkout:

```bash
cd your-atomic-fork
git am path/to/orphus/patches/atomic/*.patch
npm ci --ignore-scripts && npm run typecheck
```

`0001` adds the `packages/roundtable` package with its tests and tsconfig wiring; `0002` is
the complete Orphus rebrand (terminal branding, `orphus` binary, `/orphus` guide command,
`ORPHUS_*` env vars, `.orphus` config dir — with Atomic and Pi manifests, config dirs, and
env names still accepted as legacy fallbacks); `0003` is the ORPHUS wordmark startup banner;
`0004` closes the gaps the rebrand left against upstream's own gates (fork-legacy `.atomic`
agent-dir fallback, first-run skip for existing installs, per-source workflow path
resolution, CI env renames, lockfile sync).

To track upstream, add it as a remote and merge — the full Atomic history is preserved here:

```bash
git remote add upstream https://github.com/bastani-inc/atomic.git
git fetch upstream && git merge upstream/main
```

### CI

`.github/workflows/ci.yml` is the Orphus pull-request gate. It has three jobs:

- **`verify`** — biome, `tsc --noEmit`, the shrinkwrap check, a build of the coding-agent
  package (the root tsconfig excludes it, so nothing else typechecks the binary's own
  source), the rooms and role-launcher tests, both demos, the manifest plan, and the
  long-context baseline. Two of those steps *assert* rather than print: the demo checks the
  late-joiner ratio against a 40% ceiling, and `evals:baseline -- --check` diffs the measured
  cost of an oversized tool result against the committed scorecard. Both fail the build
  rather than reporting a worse number.
- **`suites`** — native bindings, the package build, then every inherited suite: unit and
  integration through the flake wrapper (one bounded retry, per-test duration budgets,
  diagnostics uploaded), the full coding-agent workspace suite through the same wrapper,
  the script tests, and the CI contract tests.
- **`review-gate`** — fails a pull request whose automated review reported passing but was
  actually skipped. Large diffs silently exceed CodeRabbit's file limit, so without this a
  PR could show a green review that never happened.

The inherited Atomic workflows (`test.yml`, `publish.yml`, `warm-toolchain-cache.yml`) are
disabled at the repository level: they target Blacksmith runners registered to the upstream
org, which never pick up jobs here. `publish.yml` and `warm-toolchain-cache.yml` are kept
byte-identical to upstream; `test.yml` cannot be, because it carries the rebrand's
`ORPHUS_REQUIRE_*` env-var names. Read them as a record of upstream's topology, not as this
repository's gate.

The quarantine list in `vitest.config.ts` is **empty** — both files that ever passed
through it left the same way, by fixing the cause rather than keeping the exclusion (a
missing tag fetch in one case, a provider credential leaking from the developer's
environment into test fixtures in the other). `test/ci/orphus-gate-contracts.test.ts` pins
the empty list, so growing it again is a reviewed act. Details: [docs/ci.md](docs/ci.md).

### Release archives

Release cuts use a plain version tag for the stamped release commit and a matching `v`
tag for the downloadable GitHub archives. For example, `2.1.0` is the internal
release tag and `v2.1.0` is the public archive/install tag. The archive workflow
builds **macOS arm64**, **Linux x64**, and **Windows x64** archives, checks that each
binary reports the tag's version, writes a `SHA256SUMS` for installer or manual
verification, and stages a **draft** GitHub Release for a human to publish. It
deliberately publishes to no registry.

**Platform scope.** macOS arm64 (Apple silicon), Linux x64 glibc, and Windows x64 are the built platforms.
Linux arm64 and musl (Alpine) are not built — each needs its own napi-slug `.node`
staged first, so each is another job rather than another matrix row. Intel macOS is not
planned. The shell installer manages macOS and Linux; Windows uses the portable ZIP above.
If you need another platform, open an issue rather than treating an unbuilt target as supported.

**What the archive runs on.** Its glibc floor is **2.27** — distributions providing glibc
2.27 or newer satisfy that ABI requirement (Ubuntu 18.04 ships 2.27). The floor is not
lower because the bundled `@embedded-postgres` server binaries are third-party prebuilts
requiring 2.27, and this workflow does not build them. Everything it *does* build is pinned
at 2.17 through cargo-zigbuild, and the Bun-compiled `orphus` executable needs only 2.17 on
its own.

Verify the floor on any archive rather than trusting this paragraph to stay true:

```sh
tar -xzf orphus-linux-x64.tar.gz
find orphus -type f \
  \( -perm -111 -o -name '*.node' -o -name '*.so' -o -name '*.so.*' \) \
  -exec strings -a {} + \
  | grep -o "GLIBC_2\.[0-9]*" | sort -u -t. -k2,2n | tail -1
```

The release workflow runs the same scan and refuses to stage the draft unless it reports
exactly `GLIBC_2.27`.

## From another harness (MCP)

Rooms are not Orphus-only. `orphus-roundtable-mcp` is a stdio MCP server any
MCP-capable CLI can launch — Claude Code, Codex, Gemini CLI, Cursor — joining a
room as a peer with a pinned role:

    bun packages/roundtable/bin/orphus-roundtable-mcp.ts --as critic

Mixed-model fleets do not need this: the role manifest is model-agnostic, and
`npm run roles` already launches roles on any configured provider. The bridge is
for the case providers cannot cover — a whole other agent harness, with its own
tools and context management, sitting in the discussion. Details:
[docs/roundtable-tool.md](docs/roundtable-tool.md#external-peers-over-mcp).

## Fleets: an orchestration in one command

A fleet blueprint (`.orphus/fleets/<name>.fleet.yaml`) binds **teams** of agent
definitions — with pre-assigned skills — to deliberation rooms and dispatch
fan-out, and it is a single shareable file: fleets are community artifacts,
created like skills are created.

```
/fleetsetup                       # interview → blueprint (models offered from YOUR configured providers only)
/fleet coding-team fix the flaky exporter test
```

The orchestrator routes rather than works: deliberate teams argue in a room
and converge on `FINAL:` lines the orchestrator digests; dispatch teams fan
out as named subagents whose results return. Six example blueprints ship in
`packages/fleet/examples/` — including a Kie.ai media team and a
blog-from-YouTube pipeline — and the protocol lives in the
`fleet-orchestration` skill. Reference:
[packages/coding-agent/docs/fleet.md](packages/coding-agent/docs/fleet.md).

## Orchestrating a fleet with Orca

[Orca](https://github.com/stablyai/orca) runs CLI agents in parallel git worktrees —
same machine, which is exactly the broker's trust boundary. Give each worktree a role
name, point them all at the default agent dir, and prompt each to join the task room:

> "Join roundtable room #task-123. Deliberate with your peers. Post conclusions,
> digest before deciding."

Open any agent's transcript in Orca: a handful of one-line pings and small digests,
while the full deliberation lives in the room. That asymmetry is the point — and the
demo. Full guide: [docs/orca-integration.md](docs/orca-integration.md).

## Multi-model roles

Deliberation improves when roles run on different models — distinct models
disagree more usefully. Rooms key everything by role name (`planner`, `critic`),
so any LLM can sit behind any role, and you can mix providers freely: Claude as
planner, a fast cheap model as researcher, a different family as critic. Launch
recipes, role briefs, and the phase-2 declarative role manifest:
[docs/roles.md](docs/roles.md).

## Roadmap: the self-improving harness

Orphus's second act is a loop where the harness improves itself, gated by evidence
rather than self-report — retrospective agents deliberate in a room, propose diffs to
skills or harness code, an independent verifier derives checks from the design
contract and runs the tests, and a human gate merges. The bootstrap demonstration:
ask the loop to reduce digest cost at equal information, and review the diff with
before/after metrics attached.

The loop writes what it learns into a durable memory layer:
[HMLR-Wiki / Dossier](https://github.com/kelvincushman/HMLR-Wiki), a wiki-backed,
RAGAS-benchmarked memory system (also by Kelvin Lee). Rooms stay ephemeral working
memory; Dossier compiles past deliberations into queryable, git-diffable markdown.
Memory reads stay in the explicit-fetch tier and a single `librarian` role owns all
writes, so the context-window bound stays provable. Contract:
[docs/memory.md](docs/memory.md).

Design: [docs/self-improvement-loop.md](docs/self-improvement-loop.md) · Plan and
phases: [PLAN.md](PLAN.md)

## Design decisions

Why cursors are keyed by role name, why the broker is separate from intercom's, why
there's no model-side summarization in v1 (so the bound stays provable), and the
security posture: [packages/roundtable/DESIGN.md](packages/roundtable/DESIGN.md).

(The `DESIGN.md` at the repository root is a different document — Atomic's inherited
TUI design-token spec. It has nothing to say about rooms.)

## Lineage and thanks

Orphus builds on the shoulders of [Atomic](https://github.com/bastani-inc/atomic)
(MIT) — a fork of the Pi agent harness — whose `@orphus/intercom` package
(descended from [pi-intercom](https://github.com/nicobailon/pi-intercom)) proved
lazy, broker-based agent messaging on this runtime. Orphus extends the idea from
targeted 1:1 messaging to bounded many-to-many deliberation.

## License

MIT © Kelvin Lee. Wire framing and path conventions derived from Atomic (MIT).
