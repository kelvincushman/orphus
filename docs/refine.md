# The refine loop (`/refine`)

Orphus can propose changes to its own skills and agent definitions, have them
refused by a check it cannot argue with, and be undone byte-for-byte.

> ## ⚠️ A gate is a check, not an instruction
>
> The failure this loop is arranged against is not a jailbreak. It is an agent
> optimising its way around an instruction it was given and nominally followed —
> the [Factorio incident](rlm-security-posture.md#the-threat-model-named), where
> an agent told not to cheat refined its way into cheating without ever
> disobeying. The instruction was simply not a wall.
>
> So every check here is deterministic code over the proposal's own text. None
> of it asks a model whether a proposal is acceptable, and none of it trusts a
> self-report.
>
> **A gated, reversible loop reduces the risk of an agent optimising around
> intent. It does not eliminate it.** Anyone who finishes this page believing
> the problem is solved has been misled by it.

## The four stages

```
/refine <runId>            collect evidence, brief the retrospective agent
/refine gate <runId>       judge the proposals it returned
/refine apply <runId>      apply the ones that passed
/refine rollback <runId>   restore the tree from the apply snapshots
```

Each stage reads the previous stage's output **from disk**. That is what lets a
human read the proposals between gate and apply, and what makes an interrupted
refine resume rather than restart.

### 1. Collect — the evidence bundle

`<sessionDir>/refine/<runId>/evidence/manifest.json` names every source a
retrospective may reason from: subagent output artifacts, the session transcript
and the `context_accounting` entry it carries, exported room transcripts, and
captured suite output.

Two properties, both tested:

- **Pointers, not content.** Paths and sizes only. Evidence costs the reader
  what they choose to open.
- **Nothing is silently absent.** Every source appears in `present` or in
  `missing` *with a reason*. `present.length + missing.length` always equals the
  number of sources looked for.

The second matters more than it sounds. **A room nobody exported is reported
unrecoverable, not empty.** The broker holds rooms in memory under a 500-message
cap and persists nothing; `roundtable({action:"export"})` is the only path to
disk and only the writer role may call it. A retrospective told nothing would
conclude the members never discussed the thing.

### 2. Propose — the retrospective agent

`packages/subagents/agents/retrospective.md` reads the manifest and returns
proposals as **structured output**. Each carries a target path, a unified diff,
a one-paragraph justification, and **at least one evidence citation**. A
proposal that cites nothing is rejected before anyone reads it.

The agent's tool allowlist is `read, search, find, ls`. It has no `write`, no
`edit`, no `bash`. This is the rule that makes the others credible: a proposer
holding `write` would not need to defeat the gate — it could step around it and
apply its own proposal. Deterministic code validates and writes the proposals.

Returning **zero proposals is a valid outcome**, and the agent is told so
explicitly. Inventing a plausible-looking change to appear productive is the
failure mode this loop is most vulnerable to.

### 3. Gate — deterministic refusal

| Rule | Refuses |
| --- | --- |
| `outside-allowed-surface` | Anything that is not a skill, agent definition, or prompt snippet |
| `base-prompt-immutable` | The base system prompt, named separately so the refusal survives anyone widening the surface later |
| `self-modification` | The retrospective agent's own definition |
| `capability-widening` | A diff granting `repl`, `bash`, `write`, `edit`, or `subagent` |
| `citation-does-not-resolve` | A citation naming no source in the bundle |
| `citation-names-missing-evidence` | A citation naming a source the bundle reported **missing** — the more dangerous shape, because it looks like a citation |

The surface is an **allowlist, not a denylist**. A denylist protects what
somebody thought to name, and a proposal only has to find a path nobody named.

`capability-widening` reads **added** diff lines only, so removing `repl` from an
agent is still allowed — a gate that refused every diff mentioning `repl` would
block the very change that takes it away.

Objections accumulate rather than short-circuiting: a proposal wrong three ways
is told all three. Refused proposals are kept beside their objections, because a
rejection is evidence for the next retrospective.

### 4. Apply and rollback

Every apply snapshots each target **before** touching it and records a manifest,
so `/refine rollback <runId>` restores the tree byte-identically — including
files the apply *created*, which roll back by being removed. The manifest is
written on the failure path too, so an apply that throws partway is still
rollbackable.

The applier re-checks the allowlist, stating it **independently** rather than
importing the gate's. That looks redundant and is not: two checks that share a
constant are one check referenced twice, and a single edit would open both
doors.

## Honest limitations

- **Stop-for-approval is structural, not a default** — there is no auto-apply
  setting, because `/refine apply` is a command a human types. But nothing stops
  a human from typing it without reading the diffs.
- **The gate checks that a citation resolves, not that it supports the change.**
  Whether the evidence actually justifies the edit is a judgement, which is why
  human approval remains in the loop and why the adversarial-verification
  workflow runs afterwards and can only reject further.
- **Rule 1 is enforced against `/refine`, not against everything.** Nothing here
  stops an ordinary `write` tool call from editing the base prompt. The wall is
  around self-modification through this loop, which is the path Phase 3 opened.
- **The deliberate stage is not built.** Retrospective agents do not yet argue in
  a `#retro-<runId>` room before proposing; a single agent proposes from the
  bundle. The Dossier ingest of accepted proposals is also not wired.

## Where the rules come from

[`docs/rlm-security-posture.md`](rlm-security-posture.md) — written before this
phase was built rather than after, and careful throughout about the difference
between a rule that is **enforced** (the runtime refuses, and no prompt talks it
out of that) and one that is **instructed** (it holds while the model
cooperates). Both are legitimate. Confusing them is not.
