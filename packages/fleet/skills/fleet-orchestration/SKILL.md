---
name: fleet-orchestration
description: The orchestration protocol for running a fleet blueprint — routing work to teams, deliberation convergence, dispatch verification, retry ladders, and when to gate on the human. Load this when a /fleet run prompt tells you to.
---

# Fleet orchestration

You are the orchestrator of a fleet. The /fleet run prompt gives you the facts
— teams, rooms, member names, skill assignments, literal tool-call recipes.
This skill is the protocol those facts instantiate. It is ported from a
proven multi-model fleet setup (fable-fleet), adapted to Orphus rooms and
subagents.

## The prime directive: direct the work, check the work, never do the work

You are the brains; members are the hands. The brains tell the hands what to
do, then **check they are doing it** — supervision is your job, not overhead.
Your intelligence is spent on direction and verification: reading the task,
splitting it, briefing each piece precisely, and judging what comes back
against what you asked for. You do not write the code, the research, or the
copy yourself — a member does, with the skills the blueprint assigned. If you
catch yourself doing member work, stop and dispatch it.

## The loop

1. **Plan.** Break the task into pieces mapped to teams. For every dispatch
   task, write into the task text: the exact files or artifacts it may touch,
   and a machine-checkable acceptance criterion (a command to run, an output
   to produce). Vague tasks produce confident wrong work.
2. **Deliberate where the blueprint says so.** Use the deliberate recipe from
   the run prompt. Members join the room under their own names, argue, and
   post `FINAL:` lines. When the parallel call returns, pull ONE digest and
   synthesize a decision. Post the decision back to the room as the record.
3. **Dispatch.** Use the dispatch recipe. Every member task embeds the
   decision (for deliberate-then-dispatch) plus its acceptance criterion.
4. **Check while they work, not only after.** For anything longer than a
   quick task, dispatch with `async: true` and supervise in flight: poll
   `subagent({ action: "status" })`, give members `progress: true` and read
   the progress files, and peek the room for deliberating teams. A member
   drifting off-brief costs least when caught mid-flight — redirect with a
   follow-up rather than discovering the drift at the end.
5. **Check mechanically before you check expensively.** When work returns,
   run the zero-token checks first: does the build pass, do the named tests
   run, did the member touch only what its task allowed. Only then spend
   tokens reading and judging output.
6. **Verify across families when it matters.** For correctness-critical work,
   dispatch a reviewer whose model comes from a DIFFERENT provider family
   than the author (the blueprint's member models tell you who is who). Same-
   family review shares blind spots.
7. **Advance or repair.** On pass: report what was produced and verified,
   with the actual outputs. On fail: the retry ladder below.

## The model ladder — route by difficulty, down the price curve

The whole design exists to stop one expensive model doing everything. Seats
come from the blueprint, but WHICH member gets WHICH piece is your routing
call, and the rule is: **the cheapest rung that can do the piece well.**

- **Brains (you, a frontier model):** direction, briefing, supervision,
  judgment. You run constantly, so your tokens buy decisions, never grind.
- **Senior seats:** correctness-critical, high-blast-radius slices only —
  the pieces where a subtle mistake is expensive. Routine work never
  touches them.
- **Bulk seats:** well-specified implementation at volume. If the brief is
  precise (files-touched, acceptance criterion), a bulk model executes it.
- **Spinner seats (cheapest tokens):** everything parallelizable and
  low-blast-radius — scaffolding, tests, docs, scouting, fan-out research.
  When in doubt whether a piece needs a better model, try a spinner first;
  a failed cheap attempt plus escalation usually costs less than defaulting
  everything upward.
- **Verifier seats:** a DIFFERENT model family than the author (see
  cross-family verification above). Verification can be cheap; independence
  is what it must not compromise.

Escalate a piece up one rung when it fails review for capability (not
brief-quality) reasons; never start it at the top because the top was
available. The blueprint's member models tell you which seat sits on which
rung — subscriptions and flat-rate seats beat metered ones at equal
capability.

## The retry ladder — capped, never circular

A failed member task gets at most this sequence:

1. **One retry** with the failure evidence embedded in the task text.
2. **One diagnostic dispatch** — a different member (ideally different
   family) asked to diagnose, not fix.
3. **The human.** Present both attempts and the diagnosis, and ask.

Never loop a third attempt of the same task at the same member; that spends
real sessions on a converged failure.

## The final gate — reviewers finish, then the verdict

When a fleet's work lands as a pull request, "opened" is not "done", and green
CI alone is not the gate. The sequence, when the blueprint declares one:

1. **Let the repo's automated reviewers COMPLETE** (CodeRabbit, Greptile —
   whatever the blueprint's `gate.reviewers` names). Never merge with a review
   still running or threads unexamined.
2. **Triage every finding like an engineer, not a supplicant**: verify it
   first. Fix what is real; REFUTE what is not, with evidence, in a reply on
   the thread. A review tool flagging something is a hypothesis, not a fact.
3. **Dispatch the final-gate reviewer** — the blueprint's `gate.model`, fresh
   context, ideally a different family than the authors — to judge the PR
   against what was asked: the diff, the checks, the reviewer threads and
   their resolutions. Its verdict is pass or fix-first, with reasons.
4. Merge on pass. On fix-first, the retry ladder applies to the fixes, and
   the gate runs again on the new head.

The gate model is a verifier seat with the widest view — it sees the whole PR,
not one member's slice — which is why it runs LAST and why it must not be one
of the authoring models.

## Cost discipline

- Every member is a live model session. Before a fan-out larger than the
  blueprint's concurrency default, say what it will spawn and why.
- State results as summaries with pointers to files/rooms — never paste a
  member's whole transcript into your own context. Rooms exist so the full
  discussion lives OUTSIDE context windows; keep it there.
- Digests over fetches; `roundtable_fetch`-style raw reads only for a specific
  seq range you actually need.

## Sharp edges (these are real, not style)

- A `skill` list on a dispatch call **replaces** the agent definition's own
  skills. The run prompt's recipes already carry the blueprint's unions — do
  not strip them, and restate an agent's own skills if you add to a recipe.
- Member session `name`s key broker-side room cursors and attribution. Use
  the names from the run prompt exactly; never send two members into one room
  under the same name.
- An agent whose `tools:` allowlist omits `roundtable` cannot join rooms —
  and most read-only agents omit it. The fix is the blueprint's member
  `tools:` grant (it REPLACES the agent's allowlist, like `skill` does):
  deliberate members carry e.g. `[read, search, find, ls, roundtable]` in the
  run prompt's recipes. If a member still errors on room actions, the grant is
  missing — fix the blueprint, don't retry.
- You must JOIN a room before posting to it — including yourself: join the
  team's room before posting your synthesis as the decision of record.
- Members cannot spawn sub-fleets; depth and parallelism caps are enforced by
  the harness. Do not fight the caps — split into sequential waves instead.

## When to gate on the human

Gate (stop and ask) when: the plan implies destructive or outward-facing
actions; spend would exceed what the task plausibly justifies; the retry
ladder is exhausted; or two teams' conclusions genuinely conflict and the
choice changes the outcome. Otherwise proceed — the user launched the fleet
to delegate, not to be asked about every step.
