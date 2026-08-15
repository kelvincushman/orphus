# The self-improvement loop

> **Status: the loop is built; the deliberate stage is not.** The adversarial-verification
> workflow described below is implemented — see
> [`packages/workflows/builtin/adversarial-verification.ts`](../packages/workflows/builtin/adversarial-verification.ts).
> **Collect, propose, gate, and apply are implemented** as WP 3.1–3.4, in
> [`packages/subagents/src/refine/`](../packages/subagents/src/refine/), with the
> `retrospective` agent definition at
> [`packages/subagents/agents/retrospective.md`](../packages/subagents/agents/retrospective.md).
> **Step 2, Deliberate, is not built** — retrospective agents do not yet join a
> `#retro-<runId>` room to argue before proposing; a single agent proposes from
> the evidence bundle. **The Dossier ingest in "Where the learning goes" is also
> not wired.** Both remain intent.
>
> Nothing in this document describes current behaviour unless it links to
> source. Read the rest as intent, not as a description of what runs today.

Goal: the harness improves itself along two axes, both gated by verification —
never by self-report.

## Axis 1: skills and prompts (low risk, continuous)

After a workflow run completes, a `retrospective` stage reviews the run's
evidence (tool calls, verifier reports, repair counts) and proposes edits to
skills, prompt snippets, and workflow definitions. Proposals are ordinary file
diffs, reviewed like any other change.

Loop, expressed with the primitives this fork already has:

1. **Collect** — *(built, WP 3.1)* the evidence bundle names every source a
   retrospective may reason from: subagent output artifacts, the session
   transcript and the `context_accounting` entry it carries, exported room
   transcripts, and captured suite output. It records **paths and sizes, never
   content**, so evidence costs the reader only what they choose to open.
   Every source appears in `present` or in `missing` **with a stated reason** —
   the bundle never silently omits, because a retrospective reasoning from a
   partial record it believes is complete is the failure mode
   [the security posture](rlm-security-posture.md) exists to prevent.
   Note what this means for rooms: the broker holds them in memory with a
   500-message cap and persists nothing, so a room that was never exported by
   the writer role is reported *unrecoverable* rather than *empty*.
2. **Deliberate** — *(not built)* retrospective agents join `#retro-<runId>` via
   roundtable and argue about what caused repairs; the room keeps deliberation
   out of the proposal context. Today a single agent proposes directly from the
   bundle.
3. **Propose** — *(built, WP 3.2)* the `retrospective` agent returns proposals as
   **structured output**; deterministic code validates and writes them. The agent
   is read-only by allowlist (`read, search, find, ls`) and so cannot write to
   the tree at all. This is deliberate: a proposer holding `write` could apply
   its own proposal, stepping around the gate rather than defeating it.
4. **Verify** — an adversarial-verification workflow (already builtin:
   `builtin/adversarial-verification.ts`) checks the proposal against a rubric:
   does the changed skill still pass its evals? (`skill-creator` evals apply.)
   It runs *after* the deterministic gate and can only reject further.
5. **Gate** — *(built, WP 3.3/3.4)* deterministic code, never a model, decides
   eligibility: allowed surface, no capability widening, and citations that
   resolve to evidence the bundle actually found. Applying is then a separate
   command a human types — there is no auto-apply setting to leave off.

## Axis 2: harness code (high risk, gated)

Same loop, but the target is this repository and the rubric is mechanical:
typecheck, test suite, and a reviewer agent that must produce file:line
evidence for objections. Use the author/verifier separation the runtime
enforces — the agent proposing a change to (say) `digest.ts` never verifies
itself; a fresh-context verifier derives checks from the DESIGN contract
("digest never exceeds budget + one marker line") and runs the tests.

Bootstrap sequence that demonstrably closes the loop:

1. Run the roundtable demo; capture metrics (digest chars vs transcript chars).
2. Ask the improvement workflow to reduce digest cost at equal information
   (e.g. smarter headline extraction).
3. The workflow edits `digest.ts`, reruns `test/unit/roundtable-digest.test.ts`
   plus the demo, and reports before/after metrics.
4. Human gate reviews the diff with the metrics attached.

Each accepted iteration becomes a chapter artifact: the diff, the metrics, the
verifier transcript — the book writes itself from the evidence trail.

## Where the learning goes

Retro conclusions must outlive the room they were reached in. The durable layer
is [HMLR-Wiki / Dossier](memory.md): the `librarian` role ingests the concluded
`#retro-<runId>` transcript, Dossier compiles it into wiki pages, and those
markdown diffs are simultaneously the memory write *and* the human-reviewable
evidence artifact. Rooms stay ephemeral; the wiki accumulates.
