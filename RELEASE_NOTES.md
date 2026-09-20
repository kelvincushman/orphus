# Orphus 2.3.0

This release adds a decision layer that answers Goal's cheap questions before
the model turn they would otherwise cost — and defers to the model whenever it
is not sure.

## System One

Three closed-vocabulary question primitives — yes/no, pick-one, and rate-against-
a-rubric — in TypeSafe's Jev wire shape. Fixed questions in, a probability out,
nothing generated. Goal consults it at three surfaces, each one *before* the
model step it could save: the planner's tier guess before any worker is
dispatched, a reviewer's "complete" vote before the reducer counts it, and a
worker's receipt against its declared checks before a verify turn is spent.

What it is not allowed to do is the point. It may deny, never approve: the
pre-screen can fail a leaf but cannot mark one verified, and the review surface
can withhold a vote but cannot supply one or veto a quorum others reached.
Below its confidence threshold every caller takes exactly the path it took
before, so the layer cannot make Orphus wrong — only faster when it is sure.

**It is off by default.** The `null` adapter abstains on everything, so Goal
behaves precisely as it did until `systemOne.adapter` changes. Four adapters
ship: `null`, `local` (a real classifier over a model server you run, read from
one prefill's logprobs with no text generated), `llm-wrapper`, and `typesafe`.

**It is not calibrated yet, and every receipt says so.** Each decision —
including every abstention — is recorded beside the evidence it influenced,
with the threshold applied and a hash of the question that produced it.
`scripts/systemone-labels.ts` turns finished Goal runs into labelled examples,
including runs from before the layer existed.

Against a locally served 27B it decided 8 of 9 questions on a fixed three-leaf
plan. A 0.6B decided 2 of 9 — the correct behaviour at these thresholds, not a
disappointment: an unsure model should abstain.

## Also in this release

- **Bounded handoffs to subagents.** Between `context: "fresh"` (nothing) and
  `context: "fork"` (the parent's whole transcript), `handoff` passes a child
  just the facts it needs as key→value pairs.
- **Cheapest-first model ladders.** With `cheapestFirst: true`, an agent's
  declared ladder is reordered by the registry's per-million prices.
- **A `council` fleet blueprint.** Four stances — architect, skeptic,
  pragmatist, critic — deliberate one consequential decision in a single room.
- **The browser tool is registered by default.** Chrome still launches only on
  the first `open`, every session still uses a throwaway profile, and login
  remains separately gated. `ORPHUS_ENABLE_BROWSER=0` opts out.
- **Cold extension loading drops from roughly 34s to 4s**, which every subagent
  and fleet member paid at startup.
- **One ORPHUS wordmark** across the terminal, the README and orphus.dev,
  pinned by a test so the three cannot drift apart again.
- **`/login` no longer crashes the session while you complete it**, and
  `/workflow resume <id>` no longer races the durable backend on a fresh
  process.

## Install

Download the archive for your platform and `SHA256SUMS` from this release,
verify, extract, and run. macOS and Linux users can continue using
`orphus update` or the existing shell installer.
