---
name: strategic-compact
description: Compact at a phase boundary, on purpose, after writing state down — and reach for rooms, handoff, and file-only returns before compacting at all. Use when context is filling, when a research or debugging phase has ended, or before a large fan-out.
---

# Strategic compaction

`/compact` in Orphus is verbatim line deletion: the model chooses which transcript lines to drop, and every retained line stays byte-identical. Nothing is rewritten — so a compaction is safe exactly when what you still need is either retained or written down.

## Before compacting, ask whether you need to

Compaction is the last lever, not the first. These keep the window small without losing anything:

- A deliberation belongs in a roundtable room; your context holds one digest, not the members.
- A child that needs facts gets `context: "fresh"` and a `handoff`; it does not get your transcript.
- A large return goes `outputMode: "file-only"`; a summary and a path are what you read.
- A durable conclusion goes to memory through the librarian; you fetch it later, explicitly.

If the window is still filling, compact — at a boundary.

## Compact at phase boundaries, not mid-phase

| Transition | Compact? | Because |
| --- | --- | --- |
| research → plan | yes | the plan is the distilled output; write it to a file first |
| plan → implementation | yes | the plan is on disk; free the window for code |
| mid-implementation | no | file paths, names, and partial state are what you would lose |
| after a dead end | yes | the failed reasoning only pollutes the next attempt |
| before a fan-out | yes | every ping and digest lands in this window; start it lean |
| debugging → next task | yes | traces are noise to unrelated work |

## Write state down first

Survives: files on disk, git, rooms (broker-side, cursors keyed by role name — even across a restart), memory, and every line the planner keeps. Lost: every line it deletes. So before `/compact`: the plan to a file, the decision to the room, the durable fact to memory.

## Two facts specific to Orphus

- **Count cache reads as context.** A run's `usage` reports `cacheRead` and `cacheWrite` beside `input`; a cached prefix is still read by the model. The true size is their sum, not `input` alone.
- **The planner may borrow a fallback model.** When the session model cannot rank lines, Orphus sends the compaction transcript to the next entry in `fallbackModels`, with that provider's credentials. Know the ladder before compacting a transcript you would not send elsewhere.

Adapted from ECC's `strategic-compact` skill (affaan-m/ECC, MIT). Rewritten for Orphus's verbatim compaction, its fallback-borrowing planner, and the bounded channels that make most compactions unnecessary.
