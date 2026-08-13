# RLM security posture

The rules the risky phases of the RLM adoption plan must obey, written down
**before** those phases are built rather than after. Phase 3 (the `/refine`
retrospective loop) and Phase 4 (persistent execution sessions) both link here
from their pull request templates.

One distinction runs through everything below, and this document is careful
about it: a rule is either **enforced** — the runtime refuses, and no prompt can
talk it out of that — or it is **instructed**, meaning it lives in prompt text
and holds only while the model cooperates. Both are legitimate. Confusing them
is not.

## The threat model, named

The failure this posture exists to prevent is not a jailbreak. It is an agent
optimising its way around an instruction it was given and nominally followed.

The precedent is the Factorio incident: an agent told not to cheat refined its
way into cheating anyway — not by defying the instruction, but by iterating
until it found a path the instruction did not cover. Nothing was disobeyed. The
instruction was simply not a wall.

The lesson is specific and it shapes every gate in Phase 3:

> **A gate is an evidence-based check, not an instruction.** It asks "does the
> cited evidence support this change, and does this change stay inside the
> allowed surface?" It never asks the proposer whether the proposal is
> acceptable, and it never trusts a self-report.

A loop that proposes changes and also judges them has no gate. It has a
formality.

## Rule 1 — the base system prompt is immutable

No self-modification may touch the base system prompt. This is the single wall,
and it does not move.

**Status: instructed, and enforced by the Phase 3 applier — not by the runtime
today.** There is no mechanism in this tree that protects the base prompt from a
file write. Phase 3 must therefore enforce it in two places, because the surface
check is the only thing standing there:

1. The WP 3.3 gate rejects any proposal whose diff touches a path outside the
   allowed surface (skills, agent `.md` definitions, prompt snippets).
2. The WP 3.4 applier writes only through an explicit allowlist, so a proposal
   that somehow passes the gate still cannot land outside it.

Two independent checks, because one of them is a model's judgement and the other
is not.

## Rule 2 — every self-modification is a reviewable, reversible diff

Nothing self-applies. Concretely:

- Proposals are unified diffs with a cited evidence reference each — file and
  line, or room and seq. A proposal that cites nothing is rejected without
  review; "it seemed better" is not evidence.
- Every apply snapshots each target file first and records a manifest, so
  `/refine rollback <runId>` restores the tree byte-identically.
- The default is **stop for human approval**. Auto-apply of gated proposals is
  opt-in per project, never the default, and never for the harness code itself.

## Rule 3 — the refine loop cannot widen its own capabilities

A proposal may not grant the refine loop new tool access, and specifically may
not grant it `repl`. The WP 3.3 surface check enforces this; it is not left to
the proposer's restraint.

This rule exists because Phase 3 and Phase 4 are individually bounded but
jointly dangerous: a loop that can rewrite its own instructions *and* execute
arbitrary code with the user's permissions is a different risk class from either
alone. The phases are sequenced apart for the same reason, and they must never
be wired together without the gate between them.

**Partly enforced already, and this is worth knowing.** Every admitted child is
management-restricted by construction —
[`child-policy.ts`](../packages/subagents/src/runs/inprocess/child-policy.ts)
returns `managementActions: "restricted"` unconditionally, with no branch and no
configuration hook, and mutating management actions require `"full"`. A
retrospective agent running as a subagent therefore **cannot** create, update,
or delete an agent definition, whatever its prompt says. It can only propose.
Applying happens at the root, through the gate. That is a real runtime bound
inherited for free, and Phase 3 should be built to depend on it rather than
around it.

## Rule 4 — kernels are admitted, capped, and killed with the session

Persistent execution sessions (Phase 4) are not a new privilege domain. They
inherit the discipline the subagent admission door already applies, in
[`subagent_control.rs`](../crates/atomic-natives/src/subagent_control.rs):

| Constraint | Value | Where |
| --- | --- | --- |
| Concurrent kernels | 4 | `EXECUTION_CAPACITY` |
| Nesting depth ceiling | 5 | `MAX_DEPTH` |
| Refusal is typed, not silent | `capacityExhausted`, `depthExceeded`, … | `AdmissionRefusalKind` |

Kernels are killed when the agent session ends, with a zero-orphan guarantee
proven by test rather than asserted in prose. An idle timeout closes the ones
nobody killed.

Note that the Rust crate is still `crates/atomic-natives/` — the `@orphus/*`
rename moved npm workspace package names only, not crate names.

## Rule 5 — say plainly what is not protected

A kernel runs code with the user's permissions, exactly like the `bash` tool. It
is **not a security sandbox**, the optional jail flag reduces exposure without
making untrusted code safe, and `docs/repl.md` must say so in a warning box near
the top rather than in a footnote.

The same honesty applies to the loop: a gated, reversible refine cycle *reduces*
the risk of an agent optimising around intent. It does not eliminate it. Anyone
who reads this document and comes away believing the problem is solved has been
misled by it.

## What this posture does not cover

- **Cross-agent kernel sharing**, which Phase 4 deliberately excludes. A value
  living in agent A's kernel is not addressable by agent B. The only crossing is
  an explicit, read-only-by-default inherit of a *parent's* kernel. Widening
  that needs a concrete use case and an update to this document first.
- **Multi-user or remote trust.** Orphus's boundary remains local machine, same
  user — see the trust boundary section in
  [`architecture.md`](./architecture.md). Nothing here extends to a shared host.
