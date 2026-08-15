# The self-improvement loop

> **Status: design document, one leg now built.** The adversarial-verification
> workflow described below is implemented — see
> [`packages/workflows/builtin/adversarial-verification.ts`](../packages/workflows/builtin/adversarial-verification.ts).
> **Step 1, Collect, is implemented** as of WP 3.1 — see
> [`packages/subagents/src/refine/evidence-bundle.ts`](../packages/subagents/src/refine/evidence-bundle.ts).
> It has no runtime caller yet: the bundle is assembled on demand, and the
> caller arrives with `/refine` in WP 3.4.
> **Steps 2–5 — deliberate, propose, verify-a-proposal, gate — are not built.**
> There is no `retrospective` agent definition, no proposal writer, and no
> applier. They are scheduled as WP 3.2–3.4 of the RLM adoption plan.
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
2. **Deliberate** — retrospective agents join `#retro-<runId>` via roundtable
   and argue about what caused repairs; the room keeps deliberation out of
   the proposal context.
3. **Propose** — one agent writes diffs to `skills/` or workflow prompt files.
4. **Verify** — an adversarial-verification workflow (already builtin:
   `builtin/adversarial-verification.ts`) checks the proposal against a rubric:
   does the changed skill still pass its evals? (`skill-creator` evals apply.)
5. **Gate** — human approval merges. Deterministic code, not the model,
   decides whether the gate is reached.

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
