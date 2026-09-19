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

## Verified against a real model server (19 Sep 2026)

The `local` adapter has now spoken to real OpenAI-compatible logprob servers on
a GPU box, driven through the exact `createGoalSystemOne` → `applySystemOneTiers`
/ `withheldReviewers` / `prescreenLeaf` code paths Goal uses. What held:

- **It decides, not just abstains.** Against a vLLM-served `qwen38-27b` (the
  server's own model, tools+logprobs enabled), on a fixed 3-leaf plan plus two
  reviews and two worker receipts, 8 of 9 receipts came back `abstain: false`.
  The tier score tracked real reasoning load (a changelog typo scored 0.001, an
  ordinary retry 0.97, a crash-correct cross-process lock 1.91), so the layer
  re-tiered the typo `standard → fast` and the lock `standard → judgment`.
- **Deny-only held on every surface.** The review surface withheld only the
  hand-wavy "it looks correct" vote and left the well-evidenced one standing; it
  never supplied a vote. The pre-screen failed a no-work receipt and a receipt
  whose cited check plainly did not run, and abstained rather than failing a
  genuine one. Nothing marked a leaf verified.
- **The `null` adapter is a true no-op.** Same plan and receipts under `null`:
  `enabled: false`, zero decisions, zero tier overrides, zero withheld votes,
  zero early failures, and an empty receipts file. No behaviour differed.
- **Both wire shapes and both engines parse.** llama.cpp's `/v1/completions`
  returns first-token logprobs in the `content[0].top_logprobs` array shape (the
  "chat" branch of `firstTokenLogprobs`) with tokens like `" B"`; vLLM's returns
  the legacy `top_logprobs[0]` map. Both are read correctly, and the `.trim()`
  on the token strips the leading space. `api: "completions"` was used against a
  reasoning model without the answer letter being pushed out of reach — the
  option letters stay in the top-k even when `"\n\n"` outranks them.
- **Config resolution is honest.** `.orphus/extensions/workflow/config.json`
  with `adapter: "null"` resolves with zero diagnostics; `ORPHUS_SYSTEMONE=local`
  flips only the adapter and carries the file's `local.baseUrl`/`model` through.
- **`calibrated: false` everywhere**, as designed. Model-size sensitivity is
  real: a llama.cpp `Qwen3-0.6B` on the same plan decided only 2 of 9 (correctly
  conservative at the stricter 0.9 review/verify thresholds), while the 27B
  decided 8/9. A small model abstains more, which is the safe failure.

Setup used: `llama-server` (llama.cpp b11053, single-model mode, CPU) for the
0.6B run; an already-running vLLM 0.28 serving `qwen38-27b-abl-w8a16` at
`http://127.0.0.1:8000/v1` for the 27B run.

## Not verified in this environment: a full end-to-end Goal `model_attempts` A/B

The before/after `model_attempts` comparison in the docs needs Goal's **worker**
models to run, not just the decision layer. On this box that was not safely
possible: no cloud provider auth is configured, and Goal's worker pools
(`goal-models.ts`) are hardcoded frontier-model ids, so a run would fall through
~20 failing auth attempts per leaf to the `currentModel` fallback — which itself
records a `model_attempts` entry per failure and so *destroys* the very metric
being compared. Routing the workers to the one capable local model instead
(the shared vLLM) was ruled out: this GPU also hosts a live service (n8ture,
~22 GB resident, ~1.9 GB free), and a Goal run's sustained worker generation
would contend for GPU compute with it. The System One reads are safe there
because they are single-token (`max_tokens: 1`) prefills; sustained worker
generation is not.

So the layer's *effect* was measured at the decision surface (the numbers above)
rather than as an end-to-end turn count. To get the end-to-end A/B, run it where
Goal's workers have either frontier-model auth or a dedicated (non-shared) local
endpoint, then use the docs' `jq` over `turn-*-goal-execution-report.json`.
