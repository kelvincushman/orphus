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
| Session layer — sentinel completion, echo and prompt stripping, one exec at a time | built, tested |
| `repl` tool — open / exec / peek / close / list | built, tested |
| PTY adapter over the native `PtySession` | built, **verified against the real binding** |
| Opt-in jail — macOS `sandbox-exec`, Linux `bwrap` | built, tested |
| Registration, behind `ORPHUS_ENABLE_REPL` | built, **default off** |
| Parent-kernel inherit (`repl: "inherit"`, read-only by default) | built, tested |
| Cross-agent kernel sharing | **deliberately not built** — see below |

## Switching it on

```sh
ORPHUS_ENABLE_REPL=1     # the tool appears; without this no agent can call it
ORPHUS_REPL_JAIL=1       # optional, separate: run kernels through the jail
```

Two switches rather than one, because enabling kernels and jailing them are
different decisions and folding them together would make the jail impossible to
adopt incrementally. Both default off.

**What "verified against the real binding" means.** `test/integration/repl-real-pty.test.ts`
spawns an actual `python3` through the native PTY and asserts that a value set by
one `exec` is still there for the next, and that 200 KB of real output is still
bounded. It found two bugs no fake could:

- A terminal **echoes its input**, so a script containing the literal sentinel
  satisfied the completion check the instant it was echoed — every `exec`
  returned immediately with nothing. The sentinel is now emitted as two
  concatenated halves, so only real output can match it.
- A REPL prefixes its echo with a **prompt** (`>>> `), so echo matching failed
  and every answer came back as a transcript rather than an answer.

That test skips loudly when the binding or `python3` is unavailable, so an
all-skipped run cannot be mistaken for a pass.

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
and the room.

The one crossing that **is** built is downward: a child may inherit its
*parent's* kernel, because that is a boundary the parent already controls — it
chose to spawn the child and chose what to grant. `repl: "inherit"` means
**read-only**, the safe reading of an ambiguous word; `{inherit: "<kernel>",
mode: "read-write"}` must be asked for by name. Read-only is a *syntactic*
guardrail that catches assignment and the obvious mutations, and its own refusal
message says so — Python has a dozen ways to mutate state it cannot see. Widening
this to peers needs a concrete use case and an update to the posture document
first.

**Granting `repl` to the refine loop.** The Phase 3 gate refuses any proposal
that grants `repl`, and the phases were sequenced apart for this reason: a loop
that can rewrite its own instructions *and* execute arbitrary code is a
different risk class from either alone.
