---
name: roundtable
description: Patterns for multi-agent group discussion via roundtable rooms without paying full-transcript context costs.
---

# Roundtable: multi-agent discussion patterns

Roundtable gives local agent sessions shared chat rooms. The room transcript
lives in a broker outside every agent's context window; agents pull bounded
digests when they need to catch up.

## Core rules

1. **Post small, post often.** Lead with the conclusion; link to files for detail
   (`specs/rate-limiter.md`) instead of pasting them into the room.
2. **Digest, don't peek repeatedly.** `digest` marks messages read; `peek` does
   not. Peeking in a loop re-pays the same context cost every time.
3. **Default budget first.** Only raise `budget` when the digest tells you
   messages were collapsed AND you actually need them. Use `replay` with an
   explicit `afterSeq` only when you need a raw collapsed range. When `hasMore`
   is true, continue from `lastReturnedSeq` to keep every replay page bounded.
4. **One room per concern.** `#design`, `#review`, `#incident-123`. Cross-posting
   multiplies everyone's digest cost.

## Patterns

### Planner / worker / critic discussion

```typescript
roundtable({ action: "join", room: "design", topic: "Rate limiter design" })
roundtable({ action: "post", room: "design", message: "Proposal: GCRA locally, async reconciliation at 100ms. Full spec: specs/rate-limiter.md" })
// ... do other work; activity notifications arrive as one-liners ...
roundtable({ action: "digest", room: "design" })   // catch up, bounded
roundtable({ action: "post", room: "design", message: "Adopted with a 2x fair-share node ceiling. Objections before I implement?" })
```text

### Handoff with evidence

Post the decision and where the evidence lives, not the evidence itself:

```
"EICR review done. 3 blockers, listed in review/findings.md. Blocking: yes."
```

### When to use intercom instead

Roundtable is a many-to-many room. For a targeted 1:1 exchange (asking one
specific session to do something and waiting for its answer), use `intercom`
with `ask` — it has reply-waiting semantics that rooms deliberately do not.
