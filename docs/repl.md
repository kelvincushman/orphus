# Execution kernels (`repl`)

> ## ⚠️ A kernel is not a security sandbox
>
> A kernel runs code with **your permissions**, exactly like the `bash` tool. It
> is, honestly, bash with memory. Anything `bash` could do to your machine, a
> kernel can do — read your files, reach the network, delete things.
>
> The optional jail (below) reduces exposure. It does **not** make untrusted
> code safe to run, and nothing here should be read as saying it does.
>
> This is the phase that runs model-written code with your permissions. Treat it
> that way.

## Why kernels exist

A value has two places to live: a context window, or a file. Both are bad for
big things. Pasting a 4 MB JSON file into context costs the whole file every
turn thereafter; writing it to a file means re-reading and re-parsing it on
every question.

A kernel is the third option — a REPL process that stays alive between tool
calls:

```
repl({action: "open", session: "work", language: "python"})   → work
repl({action: "exec", session: "work", code: "docs = open('big.json').read()"})
                                                              → ok (work, 84ms, no output)
repl({action: "exec", session: "work", code: "len(docs)"})    → 4238104
```

The file is loaded once, lives in `docs`, and costs the agent one line. That is
the whole idea: **context as a variable**.

## Status

| Piece | State |
| --- | --- |
| Kernel registry — cap, typed refusals, kill-on-session-end, idle reaping | built, tested |
| Output bounding — rolling buffer, capped views, counted elisions | built, tested |
| Session layer — sentinel-based completion, timeout keeping partial output | built, tested |
| **`repl` tool registration and PTY wiring** | **not built** |
| Cross-agent inherit (`repl: "inherit"`) | not built |
| Opt-in jail | not built |

The examples above show the intended tool surface. **They do not run today** —
the logic beneath them is built and tested against an injected process, and the
step that remains is wiring it to the native `PtySession` and registering the
tool. Read the table, not the examples, for what exists.

## The bounds, and which one protects what

Two separate bounds apply to a kernel's output, and they are not the same one
twice:

1. **The kernel buffer** retains the last 200,000 characters and returns at most
   4,000 in a view. This stops a process that prints forever from exhausting
   memory, and gives `peek` something to show. What it drops, it counts — an
   elided character is still in the buffer, a *dropped* one has scrolled out and
   is unrecoverable, and the two are reported differently because only one can
   be retrieved.
2. **The oversized-result spill** (`redirectOversizedToolResult`) already runs
   on every tool result and writes anything oversized to a file, replacing it
   with a pointer. This is the bound that protects the context window, and the
   `repl` tool gets it by being an ordinary tool.

## Admission and lifetime

Kernels obey the discipline in Rule 4 of
[the security posture](rlm-security-posture.md):

| Constraint | Value | Why |
| --- | --- | --- |
| Concurrent kernels | 4 | Matches `EXECUTION_CAPACITY` for subagent admission — the same scarce thing (processes this machine will run), not a second budget |
| Refusal | typed | `capacityExhausted`, `nameInUse`, `invalidName` — a refusal that says which, and names what is already open |
| Session end | all killed | The zero-orphan guarantee. Every kill is attempted even if one throws |
| Idle | reaped after 30 min | And reaped *before* capacity is judged, so four kernels left idle overnight do not permanently block a fifth |

An `exec` that times out does **not** kill its kernel. The code may still be
running, and destroying every value in a kernel because one call was slow is a
worse outcome than a slow call. Closing it is the caller's decision.

## What is deliberately not here

**Cross-agent kernel sharing.** A value in agent A's kernel is not addressable
by agent B. Sharing state across trust boundaries multiplies the security
surface for marginal benefit; composition across agents stays files, digests,
and the room. The one planned crossing is an explicit, read-only-by-default
inherit of a *parent's* kernel — enough for "spawn three reviewers over one
loaded dataset" without open sharing. Widening this needs a concrete use case
and an update to the posture document first.

**Granting `repl` to the refine loop.** The Phase 3 gate refuses any proposal
that grants `repl`, and the phases were sequenced apart for this reason: a loop
that can rewrite its own instructions *and* execute arbitrary code is a
different risk class from either alone.
