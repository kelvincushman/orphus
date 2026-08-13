# The self-improvement loop

> **Status: design document.** The adversarial-verification workflow described
> below is implemented — see
> [`packages/workflows/builtin/adversarial-verification.ts`](../packages/workflows/builtin/adversarial-verification.ts).
> **The retrospective and proposal stages are not built.** Searching this tree
> for `retrospective` finds prose in this file, `README.md`, and `PLAN.md`, and
> no implementing source. It is scheduled as Phase 3 of the RLM adoption plan.
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

1. **Collect** — the workflow checkpoint already records stages, verifier
   verdicts, and repair cycles.
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
