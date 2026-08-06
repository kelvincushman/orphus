# Long-term memory: HMLR-Wiki / Dossier

Rooms are deliberately *ephemeral*: ring buffers, broker-side cursors, bounded
digests. That is working memory for a live deliberation, and it must stay small.
What Orphus does not get from rooms is durable knowledge — what past
deliberations concluded, what the retro loop learned, what the codebase's design
contracts actually say. That layer is
[HMLR-Wiki / Dossier](https://github.com/kelvincushman/HMLR-Wiki): a wiki-backed
memory system for LLM agents, built by Kelvin Lee on HMLR (Sean VanWinkle) and
Karpathy's LLM-Wiki pattern.

The two systems solve different problems and compose without overlap:

```
room transcript (ephemeral, broker)  ──after task──►  dossier ingest (durable, wiki)
agent needs history                  ──tool call───►  dossier query (explicit fetch)
```

## The contract

1. **Memory reads live in the explicit-fetch tier only.** Orphus's core claim is
   that what enters an agent's context is bounded by deterministic, model-free
   machinery. Dossier's retrieval is LLM-in-the-loop (extractors, rerankers, a
   sentence-level grounding filter) — powerful, but neither deterministic nor
   provably bounded. So memory content enters context only when an agent
   explicitly calls the memory tool, never via activity pings and never inside a
   digest. The provable-bound story stays clean.

2. **One writer: the `librarian` role.** Concurrent agents writing shared memory
   is the classic failure mode (write contention, conflicting facts, unclear
   provenance). The role model already provides the answer: exactly one role
   owns `ingest` and the gardener/consolidation pass; every other role is
   read-only. This is a design rule, not new code — declare a `librarian` in
   `orphus.roles.yaml` when a task needs durable memory.

3. **Room transcripts are ingested post-task, not live.** When a room's task
   concludes, the librarian ingests the transcript as a raw source; Dossier's
   extractors compile it into entity/concept pages. Past deliberations become
   queryable without any agent ever holding them in context — the same
   asymmetry rooms provide, extended over time.

4. **Memory writes are diffs.** Dossier's store is markdown in git. Every
   ingest and every gardener pass is a reviewable diff, which is exactly the
   evidence-gated shape the self-improvement loop requires — retro agents in
   `#retro-<runId>` compile conclusions into wiki pages, and those page diffs
   are the book's evidence artifacts. See
   [self-improvement-loop.md](self-improvement-loop.md).

5. **Integration is a boundary, not a port.** Dossier is Python; Orphus is
   TypeScript. The tool shells out to the benchmarked implementation
   (`python -m dossier query|ingest|gardener`) rather than porting it — a port
   would drift from the code the RAGAS results were measured on.

## The tool (shipped)

`packages/roundtable/memory-tool.ts` registers a `memory` tool alongside
`roundtable`, wired in `packages/roundtable/index.ts`:

```typescript
memory({ action: "query",  question: "what did we decide about rate limiting?" })
memory({ action: "doctor" })                                        // is the backend reachable?
memory({ action: "ingest", source: "<path>" })                     // librarian only
memory({ action: "gardener" })                                     // librarian only
```

It shells out to the Dossier CLI, configured entirely by environment:

| Variable | Default | Meaning |
|---|---|---|
| `ORPHUS_MEMORY_COMMAND` | `python -m dossier` | Base command, split on whitespace |
| `ORPHUS_MEMORY_DIR` | *(unset)* | Dossier project dir — where `raw/` and `wiki/` live |
| `ORPHUS_MEMORY_WRITER_ROLE` | `librarian` | The one role allowed to write |

The design keeps the contract mechanical:

- **The gate runs before any subprocess.** `gateAction` in
  `packages/roundtable/memory/dossier.ts` decides read-vs-write purely from the
  action and the session's role (`pi.getSessionName()`); a non-writer is refused
  before Dossier is ever spawned.
- **argv is a real vector, never a shell string.** `runDossier` passes the
  question or source path as separate `spawn` arguments with no shell, so
  agent-supplied text is data, not a command — no injection surface.
- **Reads are inherently explicit-fetch.** A tool call is a deliberate act by
  the agent; nothing here pushes into a ping or a digest, so the bound holds.
- **A missing backend is a clear notice, not a crash.** If Dossier is not
  installed, the tool returns a "configure `ORPHUS_MEMORY_COMMAND`" message.

Ingest takes a file path (matching `python -m dossier ingest <path>`). To
capture a concluded room, the librarian dumps the transcript under `raw/` first,
then ingests that file — post-task, never live.

## What the benchmark does and does not show

Dossier's headline result: on HMLR's own Hydra9 Hard Mode (doc-variant), it
matches HMLR on faithfulness (1.000) and context recall (1.000) and exceeds it
on precision (0.938 vs 0.23). Stated honestly:

- The defensible headline is **faithfulness/recall parity with much higher
  precision**. The "+0.236 3-metric mean" is mostly that one anomalously low
  baseline precision number.
- RAGAS on Hydra9 measures **single-session retrieval QA**, not multi-agent
  memory semantics. Write contention, provenance, and staleness during live
  deliberation are addressed by the contract above (single writer, post-task
  ingest, explicit fetch) — by design, not by the benchmark.

## Why this over a hosted memory service

Local-first matches the broker's trust boundary (same machine, no cloud
dependency); the store is inspectable markdown rather than an opaque index; the
whole demo remains runnable offline on stage; and the bench harness is
reproducible (`pytest --run-bench`), so memory-layer changes can be gated on
measured evidence like everything else in Orphus.
