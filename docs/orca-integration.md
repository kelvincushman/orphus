# Running this fork under Orca

[Orca](https://github.com/stablyai/orca) orchestrates CLI agents in parallel
git worktrees and already ships a Pi integration (`src/main/pi/`), which this
fork remains compatible with.

## Setup

1. Install the fork globally so Orca's PATH lookup finds it:
   ```bash
   bun add -g @bastani/atomic   # or npm/pnpm from your fork checkout
   ```
2. In Orca, add the agent as a Pi-compatible CLI agent (Settings → Agents).
   Atomic keeps Pi-compatible extension points, and Orca's Pi status extension
   reads the same session state files.
3. Launch multiple worktrees from one prompt as usual.

## Making Orca worktrees deliberate with each other

Orca runs each agent in its own worktree but on the same machine — which is
exactly roundtable's trust boundary. To have a fleet of Orca-spawned sessions
share a discussion room:

- Set a shared agent dir so all worktrees hit the same broker:
  `ORPHUS_CODING_AGENT_DIR=~/.atomic/agent` (the default already is shared).
- Give each worktree a role name (`--name planner`, etc.) so cursors and
  attribution are stable. Without it the session falls back to `session-<pid>`
  and loses its cursor on restart.
- Prompt each agent to `join` the task room, e.g. `#orca-task-123`, post
  conclusions, and `digest` before major decisions.

Or declare the whole fleet once in [`orphus.roles.yaml`](../orphus.roles.yaml)
and let the launcher emit the Orca commands — one terminal per role, each in
whichever worktree that role selects:

```bash
orphus-roles --format orca | sh
```

```
orca terminal create --worktree 'name:planner' --title 'planner' --command 'orphus --name planner …'
```

Give a role its own checkout with `worktree: name:planner` in the manifest;
roles default to the `active` worktree. Create the worktrees first with
`orca worktree create --name <role>`. See [roles.md](roles.md).

The Orca UI shows each agent's own transcript; the shared discussion lives in
the broker and each transcript only ever contains that agent's bounded digests
— which is the point.

## Demo choreography (for the book / talks)

1. Open Orca, fan one prompt across three worktrees: planner, researcher, critic.
2. Prompt template per role: "Join roundtable room #design. Discuss the rate
   limiter design with your peers. Post conclusions, digest before deciding."
3. Show any agent's transcript: a handful of one-line activity pings and small
   digests — while the full discussion (visible via
   `bun packages/roundtable/demo/run-demo.ts`-style inspection or a `peek`)
   is far larger.
