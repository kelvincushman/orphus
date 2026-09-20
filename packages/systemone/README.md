# @orphus/systemone

A decision layer that runs **before** the model, not instead of it.

Kahneman's two systems, as two roles inside a run. System 2 is the consultant:
a full model turn that reads everything, reasons, and writes. Orphus already has
it — the planner, the workers, the verifiers, the reviewers. System 1 is the
triage nurse: it answers only fixed questions, it answers fast, and when it is
not sure it says so and sends the case on. This package is the nurse's desk.

For the user-facing account — settings, thresholds, receipts, how to turn it on
— read [packages/coding-agent/docs/systemone.md](../coding-agent/docs/systemone.md).
What follows is why the shapes are what they are.

## Three questions, and nothing else

```ts
noul:   { instructions, criteria?: { true?, false? } }          // yes or no
choice: { instructions, criteria: { label: description|null } } // pick one, ≤255
score:  { instructions, criteria: [level0, level1, …] }         // rate, ≤11 levels
```

Every answer comes back as a probability distribution over the answers *the
caller supplied*. Nothing is generated, so a malformed answer is not a failure
mode — only an uncertain one. That is what makes the layer safe to put in front
of anything.

The shapes mirror TypeSafe's `/v1/systemone` wire schema rather than inventing a
parallel vocabulary, and the two limits above are theirs. The payoff is
portability: the `typesafe` adapter is a thin HTTP client instead of a
translation layer, and the same question can be answered by a local model and by
Jev and the two compared on identical state. The cost is that our questions
inherit their ceilings even where we would not have hit them.

## The abstain band is the whole safety argument

A `Decision` is an answer plus `abstain`. Below the threshold the caller **must**
take the System 2 path it would have taken anyway. This is Orphus policy, not a
field any model returns, and it is what lets the layer be wrong without making
Orphus wrong: a confident mistake is bounded by where confidence is trusted, and
an unsure answer costs only the latency of asking.

Two rules follow, and the Goal call sites hold to both:

- **It may deny, never approve.** The leaf pre-screen can fail a leaf before the
  verifier runs; it can never mark one verified. The reviewer vote can withhold a
  reviewer's "done"; it can never supply one.
- **It runs before the step it replaces, never after.** Re-judging a completed
  System 2 step would make this an override layer. It is a triage layer.

## Confidence

`noul` returns a bare probability, matching the wire shape. Its confidence is
`|2p − 1|`, which is exactly the two-label case of the choice formula
`(max_p − 1/n) / (1 − 1/n)`, so one threshold means the same thing whichever
primitive a surface happened to use.

`score` gets its own measure, because ordered levels make spread meaningful in a
way a flat maximum misses. A distribution split between adjacent levels is a
confident "about here"; one split between the extremes is not; and both can
share a peak.

## Calibrated, eventually

Jev is trained for calibrated confidence. Nothing here is, yet. Every receipt
carries `calibrated: false` until a calibration fitted on Orphus's own outcomes
is applied, and until then the thresholds stay conservative. Receipts also carry
`question_hash`, so when a question's criteria are revised, outcomes can still be
credited to the wording that produced them — without that, harvested labels would
silently mix generations of the same question.

## Adding an adapter

Implement `SystemOne` and return maximally uncertain answers (`uncertainAnswers`)
for anything you could not decide — a timeout, an unreachable backend, a
malformed response. Never throw for an undecided answer: an adapter that throws
takes down the run it was supposed to make cheaper.
