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

**Status: enforced for the refine loop; still instructed everywhere else.**
Both checks this rule asked for are built and tested:

1. The WP 3.3 gate ([`gate.ts`](../packages/subagents/src/refine/gate.ts))
   rejects any proposal whose target lies outside the allowed surface (skills,
   agent `.md` definitions, prompt snippets), and refuses base-prompt paths
   under their own named rule so the refusal survives anyone widening that
   surface later.
2. The WP 3.4 applier
   ([`applier.ts`](../packages/subagents/src/refine/applier.ts)) writes only
   through its **own** allowlist, stated independently rather than imported from
   the gate. Sharing the constant would make two checks into one check
   referenced twice, and a single edit would still open both doors.

Two independent checks. **Both are deterministic** — neither is a model's
judgement — and that is the point: the value is in their *independence*, not in
their differing in kind. Either one alone is a single edit away from not being a
check.

What this does **not** cover: nothing stops a file write to the base prompt from
outside the refine loop — an ordinary `write` tool call, a `bash` heredoc, a
human. The rule is enforced against *self-modification through `/refine`*, which
is the path Phase 3 opened. It remains prompt text for every other path.

## Rule 2 — every self-modification is a reviewable, reversible diff

Nothing self-applies. Concretely:

- Proposals are unified diffs with a cited evidence reference each — file and
  line, or room and seq. A proposal that cites nothing is rejected without
  review; "it seemed better" is not evidence.
- Every apply snapshots each target file first and records a manifest, so
  `/refine rollback <runId>` restores the tree byte-identically.
- Stop for human approval is **structural, not a default**. There is no
  auto-apply setting to leave off: `/refine apply <runId>` is a separate command
  a human types. A default is a value someone can change in a config file; this
  is a step someone has to take.

## Rule 3 — the refine loop cannot widen its own capabilities

A proposal may not grant the refine loop new tool access, and specifically may
not grant it `repl`.

**Status: enforced.** The gate's `capability-widening` check reads the *added*
lines of a proposal's diff and refuses any that grant `repl`, `bash`, `write`,
`edit`, or `subagent` on a `tools:` line. Added lines only, deliberately: a gate
that refused every diff mentioning `repl` would block the very change that takes
`repl` away.

The retrospective agent is additionally read-only by allowlist — `read, search,
find, ls`, with no `write`, `edit`, or `bash` — so it cannot apply its own
proposal even before the gate sees it. That was a correction found while
building: the plan had the agent write proposals to disk itself, which would
have let a proposer step around the gate rather than defeat it.

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
is **not a security sandbox**, and [`docs/repl.md`](./repl.md) says so in a
warning box at the top rather than in a footnote. The jail contemplated in the
plan is **not built**; when it exists it will reduce exposure without making
untrusted code safe, and until then there is no sandboxing of any kind.

**Status: the warning is written and the jail is built, opt-in and off.**
`docs/repl.md` carries the status of every piece. The tool is registered behind
`ORPHUS_ENABLE_REPL` (default off) and the jail behind `ORPHUS_REPL_JAIL`
(separate, also off), and the PTY path is verified against the real native
binding rather than only against a fake.

What remains unbuilt and is labelled as such: **cross-agent** kernel sharing.
The downward crossing — a child inheriting its parent's kernel, read-only unless
`read-write` is named — is built, and its read-only check is a syntactic
guardrail that says so in its own refusal rather than implying containment.

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
