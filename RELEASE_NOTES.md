# Orphus 2.1.0

This release makes Orphus feel much less hidden while it works. Substantial
coding tasks now route through native Goal by default, Goal opens its live graph
automatically, and background workers are visible in the terminal instead of
only running out of sight.

## What changed

### Goal is now the normal path for serious work

For bigger build, fix, refactor, or release tasks, Orphus now uses native Goal
as its core completion loop. Goal plans first, splits the job into owned leaves,
runs a rolling team of workers, verifies each leaf with recorded evidence, then
uses reviewers and a reducer before calling the work complete.

Small direct answers and low-risk edits can still stay inline. The point is not
magic infallibility; it is fewer false finishes because the plan, workers,
checks, and final review are part of the runtime path.

### You can see the workers now

Interactive Goal runs now open the existing workflow graph automatically, so you
can see the stages, workers, status, model, elapsed time, and dependencies
without first discovering a hidden keybinding.

Background subagents also show in the terminal as:

```text
ORPHUS HARNESS · workers live
Worker 1/3
Worker 2/3
Worker 3/3
```

That borrows the useful visibility idea from Fusion Harness-style terminals:
clear live lanes that show work is moving. Fusion Harness is not a dependency,
and Orphus's own workflow runtime stays in charge.

### Startup fix for installed v2.0.0 users

The installed v2.0.0 build could fail at startup with:

```text
Cannot find module '@orphus/roundtable/bounded-render.ts'
```

v2.1.0 includes the installed-runtime alias for that shared roundtable renderer,
so bundled subagents can load again.

### REPL correction carried forward

The unreleased REPL fix is included too: live kernel results no longer leak the
completion sentinel echo, and genuine output that merely mentions the sentinel
is no longer stripped by mistake.

## Install / upgrade

If Orphus is already installed:

```bash
orphus update
```

Or fresh, pinned to this release:

```bash
curl -fsSL https://raw.githubusercontent.com/kelvincushman/orphus/main/install.sh | sh -s -- --ref v2.1.0
```

## Full changelog

See:

- `packages/coding-agent/CHANGELOG.md` for the REPL correction and installed
  runtime alias fix.
- `packages/workflows/CHANGELOG.md` for native Goal routing and automatic graph
  attachment.
- `packages/subagents/CHANGELOG.md` for the visible `ORPHUS HARNESS · workers
  live` panel and `Worker N/M` lane labels.
