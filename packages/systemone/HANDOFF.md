# Handoff: what the System One layer still needs

Written at the end of the session that built the layer, for whoever picks it up.
The design and the reasoning are in `README.md` and
`packages/coding-agent/docs/systemone.md`; this file is only the list of things
that are not done, in the order they are worth doing.

## 1. Fit a calibration (the ship gate for trusting the band)

Every receipt says `calibrated: false`, and that is accurate: a reported 0.85
does not yet mean "right 85% of the time". Until it does, the abstain band is a
heuristic rather than a guarantee, and the thresholds stay conservative.

What exists already: `scripts/systemone-labels.ts` emits labelled decisions with
the layer's own prediction joined on where a run carried receipts. The `local`
adapter takes a per-primitive temperature (`LocalCalibration`) and applies it
before deriving confidence, and `weightsFromLogprobs` is unit-tested at
temperature 1 and above.

What to build: a script that fits one temperature per primitive on harvested
labels, reports expected calibration error and a reliability diagram under
`evals/`, and writes a file the adapter can load. Then add the `calibration`
config key back — it was deliberately left out because nothing produced the
file, and a setting that silently does nothing is worse than its absence.

Do not lower the default thresholds before this lands.

## 2. Let System 2 rewrite the questions

Both talks that prompted this work describe the same loop: record the decisions
and their outcomes, have a slow model read them periodically, and let it rewrite
the criteria and thresholds. It needs no training and works with any adapter.

The prerequisite shipped: every receipt carries `question_hash`, the hash of the
question's exact instructions and criteria, so an outcome is attributable to the
wording that produced it rather than to a question since revised.

What to build: `scripts/systemone-refine.ts` — read receipts plus harvested
labels, group by `question_hash`, find the questions whose confident answers
most often disagreed with the outcome, and propose edited criteria for a human
to approve. Proposals only; nothing self-applies.

## 3. A second engine for `local`

The logit read handles arbitrary instructions and code-heavy state, which is
what Goal needs. It is not the cheapest possible answer for the simple fixed
questions.

Verified as available and appropriately licensed (18 Sep 2026):
`MoritzLaurer/ModernBERT-base-zeroshot-v2.0` (Apache-2.0, 8k context),
`knowledgator/gliclass-edge-v3.0` (Apache-2.0, 131 MB, scores every label in one
forward pass, the closest architecture to Jev).

Two runtimes are possible and neither is free: a Python sidecar on the protocol
pattern `packages/transcribe` already ships (versioned JSON-Lines,
consent-then-checksum download, pinned catalog), or in-process ONNX — whose
`onnxruntime-node` install script fetches from NuGet, the same host that breaks
GitNexus behind a proxy, and whose Bun-binary compatibility is unverified.

## 4. More surfaces

Wired: leaf tier, reviewer vote, leaf pre-screen. Not wired, in rough order of
expected value:

- **Skill selection.** TypeSafe's cookbook reports wrong-skill loads falling
  from 17% to 7.3% for a 182-skill agent, and it would cut skill descriptions
  out of every turn's context. Lives in `packages/subagents`, which is not
  bundled, so it needs the loader alias and virtual-module wiring that
  `@orphus/roundtable/bounded-render.ts` needed.
- **Room convergence** (`packages/fleet/blueprint/render.ts:120`): replace the
  `FINAL:` string prefix with `noul("position_settled")` plus a choice over
  recent sequence numbers, keeping the prefix as a hint.
- **Post etiquette** (`packages/roundtable/roundtable-tool.ts`, the `post`
  case): `score("transcript_bloat")`, rejecting above a threshold.
- **Richer pre-screen state.** The diff is not currently in the state, so
  "weakened a test?" and "risk surface" cannot be asked. Adding it would also
  let the pre-screen catch a receipt that describes work the diff does not show.

## 5. Digest ordering — last, and only with proof

The original handoff proposed ranking digest entries by salience rather than
recency. It stays last for a reason: `packages/roundtable/DESIGN.md` commits to
a model-free digest, and `bounded-render.ts` is shared by five other callers.

If it is attempted: inject ordering in `digest.ts` only, never modify
`bounded-render.ts`, pin the newest two entries, and treat the CI late-joiner
ratio as the test — the 40% ceiling must *drop*, not merely hold.

## Things to be careful of

- **The adapter must never throw.** Every one abstains on timeout, unreachable
  server, malformed response, or schema failure. A layer meant to make runs
  cheaper must not be able to fail one.
- **Deny, never approve.** The pre-screen can fail a leaf; it must never mark
  one verified, and must never skip verification by agreeing with the worker.
  The review vote can withhold; it must never supply one or veto a quorum.
- **Ask before, never after.** Re-judging a completed model step turns this into
  an override layer.
- **The null adapter is the acceptance test.** If any behaviour differs under
  `null`, the wiring is wrong.

## Not verified in this environment

The `local` adapter was proven against fake OpenAI-compatible servers covering
both response shapes, timeouts, unreachable hosts and malformed payloads. It has
never spoken to a real model server: this sandbox has no GPU and the model hosts
are blocked by its network policy. Its first real run is a laptop smoke test
using the commands in the docs, and the receipts from that run are the evidence.
