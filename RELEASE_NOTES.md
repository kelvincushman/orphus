# Orphus 2.0.1

A patch release: the REPL kernel's results are now clean *and* complete.

## Fixed

### The sentinel echo no longer leaks — and honest output no longer disappears

Every `exec` against a live kernel ends with a printed sentinel so completion is
detected rather than guessed. Two defects around it are fixed together:

- **The echo leaked.** The sentinel was printed in two halves (so its own echo
  cannot end an exec early), but the halves were split at a token-dependent
  midpoint — the echo filter matched nothing, and the
  `print("__ORPHUS_KERNEL_" + "DONE_…")` line rode along in every result. The
  split is now pinned after a stable marker, and the three echo shapes a live
  kernel actually produces (doubled first-exec echo, an answer interleaved
  between the echoed lines, and both at once) are consumed in order. Python
  kernels also start with `PYTHON_BASIC_REPL=1`, removing the pyrepl capability
  warning Python 3.13+ printed before the first echo.
- **The fix's first cut over-stripped.** Filtering by marker *content* deleted
  genuine program output that merely mentioned the marker — an agent grepping
  this very repository from inside a kernel would silently lose those lines.
  Stripping is now by *provenance*: only the script's own echoed sentinel-print
  line is removed.

Every fix carries a regression test proven to fail without it, and the change
is verified against real interpreters: the real-PTY integration suite runs the
merged code against live `python3` and `node` kernels.

## Install / upgrade

```bash
orphus update
```

Or fresh, pinned to this release:

```bash
curl -fsSL https://raw.githubusercontent.com/kelvincushman/orphus/main/install.sh | sh -s -- --ref v2.0.1
```

## Full changelog

`packages/coding-agent/CHANGELOG.md`, under `2.0.1`. Also since 2.0.0, under
the hood: the CI review gate now requires positive evidence of a completed
automated review and is safe against reviewer rate limits and shell-pipeline
edge cases — infrastructure, but it guards everything above.
