# Long-context baseline

What an oversized tool result actually costs the parent's context window,
measured through the runtime rather than modelled.

```sh
npm run evals:baseline
```

This is WP 0.1 of the RLM adoption plan. Every later phase is judged on whether
parent context shrank, so this establishes the number those phases cite. It
**fails rather than reports**: a regression against the committed scorecard
exits non-zero, in the same spirit as `npm run demo`.

## Why it is not in the Pier/Harbor adapter

The rest of `evals/` is an adapter that runs Deep SWE tasks in Docker sandboxes
with the agent **installed from npm**. That measures a published build, not your
working tree — so it cannot observe the context accounting this baseline depends
on, which lives in `packages/coding-agent/src/core/context-accounting.ts`. It
also cannot measure a change you have not published, which is the only kind of
change a baseline is for.

This runner therefore follows the `npm run demo` precedent instead: local,
in-process, against the working tree.

## What it measures

For corpora of 50k, 130k and 260k estimated tokens, each returned as a tool
result:

| Column | Meaning |
| --- | --- |
| `unbounded` | characters entering context if the result is returned whole — the paste-it-in baseline |
| `bounded` | characters entering context once the runtime substitutes a file reference, via the real spill path |
| `ratio` | bounded ÷ unbounded |
| fits window | whether the unbounded form fits a 200k-token reference window at all |

The property being asserted is that **bounded cost is flat in input size**. A
bound that grows with its input is truncation wearing a bound's clothes, so the
runner fails if the largest corpus costs more than 1.5× the smallest.

It also fails if the bounded form gets *too* small: the replacement is supposed
to carry a preview and a path, and a bound met by discarding those would score
beautifully while being broken.

## What it does not measure, and why

**Model-backed task families.** The plan's aggregate-Q&A, repo-comprehension and
fleet-deliberation families need a real model. They are deliberately not in this
file:

- they need a configured subscription, so they cannot run in CI
- they do not reproduce run-to-run, so gating on them would make a green build
  depend on a model's mood

They belong in a separately recorded run whose numbers are cited as measurements
with variance, never as a regression gate. Keeping the two apart is what lets CI
gate honestly on the half that is genuinely deterministic.

**Real tokenization.** Token figures use the repo's own conservative `chars / 4`
heuristic (see `estimateTokens` in `compaction.ts`). Characters are measured;
tokens are estimated, and every field name says which.

**The 260k row is expected to say "NO".** No model configured in this repo has a
260k-token window. Recording that the paste-it-in approach simply does not fit is
the finding, not an error — it is the failure Phase 4's persistent execution
sessions exist to beat.

## The scorecard

`scorecard.json` is committed and is the artifact later phases diff against. It
carries no derived fields: everything in it was measured, and `schema` is bumped
if the method changes in a way that breaks comparison with earlier runs.
