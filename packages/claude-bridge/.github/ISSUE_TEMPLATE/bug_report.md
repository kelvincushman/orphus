---
name: Bug report
about: Report something broken in pi-claude-bridge
labels: bug
---

## What happened

<!-- Brief description of the problem and what you expected instead. -->

## Reproduction

<!-- If possible, a minimal sequence that reproduces it: which models you were
using, what prompts, any switches or aborts. A short shell/pi transcript is
ideal. -->

## Debug log

Run the failing scenario again with `CLAUDE_BRIDGE_DEBUG=1` set. This writes:

- `~/.pi/agent/claude-bridge.log` — the main bridge log.
- `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — one file per
  Claude Code CLI invocation, matched by timestamp to the bridge log.

Attach or paste the last ~50 lines of the bridge log around the failure, plus
the matching `cc-cli-logs/` file if the issue involves Claude Code's own
behavior (resume failure, "No conversation found", tool calls, etc.).

<details><summary>Bridge log</summary>

```
paste here
```

</details>

<details><summary>CC CLI log</summary>

```
paste here
```

</details>

## Environment

- **pi-claude-bridge version:**
- **Platform:** <!-- macOS 14 / Ubuntu 24.04 / WSL2 / etc. -->
