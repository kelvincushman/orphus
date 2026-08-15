# Execution kernels (`repl`)

> ## ⚠️ A kernel is not a security sandbox
>
> A kernel runs code with **your permissions**, exactly like the `bash` tool. It
> is, honestly, bash with memory. Anything `bash` could do to your machine, a
> kernel can do — read your files, reach the network, delete things.
>
> A jail is planned — an opt-in `sandbox-exec` profile on macOS, a user-namespace
> wrapper on Linux — and **is not built**. Even once it exists it would reduce
> exposure without making untrusted code safe to run. There is no sandboxing
> today, of any kind.
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
| Session layer — sentinel completion, echo stripping, one-exec-at-a-time | built, tested |
| `repl` tool handler — open / exec / peek / close / list | built, tested |
| PTY adapter over the native `PtySession` | built, tested against an injected session |
| Opt-in jail — macOS `sandbox-exec`, Linux `bwrap` | built, tested |
| **Registration into the live agent's tool list** | **not wired — deliberate, see below** |
| Cross-agent inherit (`repl: "inherit"`) | not built |

**The tool is not registered, and that is a decision rather than an omission.**
Everything above is built and unit-tested, but no agent can call `repl` today.
Switching on a tool that executes model-written code with the user's permissions
is not something to do on a user's behalf — the plan itself names the kernel flag
as one of three release kill switches. Registration should land as an explicit
opt-in, with someone choosing it.

**Also not verified end-to-end:** every test here drives an *injected* session,
never the real native binding. The adapter's contract with `PtySession` — that
`closeStdinAfterCommand: false` keeps a REPL alive and `write()` feeds it — is
read from `pty.rs` and `bash-pty-native.ts`, not yet observed against a live
process. That is the first thing to check when registration happens.

## The bounds, and which one protects what

Two separate bounds apply to a kernel's output, and they are not the same one
twice:

0. **Echo stripping.** A PTY echoes its input, so without removing it every
   `exec` would hand back the code just sent — and an expression that printed
   nothing would look like it printed something, defeating the one line a kernel
   exists to produce. Echoed lines are consumed in order from the start, so a
   program that legitimately prints a line identical to its own source still has
   that output returned.
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
| Refusal | typed | `capacityExhausted`, `nameInUse`, `invalidName`, `invalidOption` — a refusal that says which, and names what is already open |
| Session end | all killed, best-effort | Every kill is attempted and the registry is emptied either way, so one failure cannot spare the rest and nothing is left tracked. This is **not** a guarantee that every process died: a `kill` that throws is a process this layer can no longer reach |
| Idle | reaped after 30 min | And reaped *before* capacity is judged, so four kernels left idle overnight do not permanently block a fifth |

**One execution at a time.** A second `exec` on a busy kernel is refused with
`KernelBusy` rather than queued. Allowing two would let each reset the other's
output buffer, so neither could tell which sentinel was its own.

An `exec` that times out does **not** kill its kernel. The code may still be
running, and destroying every value in a kernel because one call was slow is a
worse outcome than a slow call. Closing it is the caller's decision — and the
kernel accepts work again afterwards, since a kernel bricked by one slow call
would strand every value in it. That is precisely why each execution needs its
own token: a stale sentinel from the timed-out call may still arrive.

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
