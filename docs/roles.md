# Multi-model roles

Orphus deliberation works best when roles are played by *different* models —
distinct models disagree more usefully, which is exactly what you want from a
critic. Roles are first-class in the design: room membership, read cursors, and
attribution are all keyed by role name, so a role doesn't care which LLM sits
behind it — or if you swap that LLM mid-project.

## The role contract

A role is three things:

1. **A name** — `planner`, `researcher`, `critic`, `reviewer`. This is the
   identity in rooms (`planner#7: …`) and what cursors persist under.
2. **A model assignment** — provider + model the session runs on.
3. **A brief** — system-prompt addition describing the role's job and its room
   etiquette (post conclusions, digest before deciding).

## Launching a mixed-model roundtable (today)

Each Orphus session takes its provider/model at launch. Three terminals — or
three Orca worktrees — on the same machine share one broker automatically:

```bash
# Terminal 1 — the planner, on a strong reasoning model
orphus --provider anthropic --model claude-opus \
  --append-system-prompt ./roles/planner.md

# Terminal 2 — the researcher, on a fast cheap model
orphus --provider openai --model gpt-fast \
  --append-system-prompt ./roles/researcher.md

# Terminal 3 — the critic, on a different family entirely
orphus --provider xai --model grok \
  --append-system-prompt ./roles/critic.md
```

Each role brief ends with the same coordination footer:

> Join roundtable room `#<task>`. Post conclusions, not transcripts. Pull a
> digest before major decisions. Your role name is `<role>`.

Sessions inherit role names via `--session-name` or the `ORPHUS_INTERCOM_GROUP` /
room-join prompt; in Orca, name each worktree after its role.

## Example role briefs

**planner.md** — "You decompose the task, assign questions to the room, and own
the final decision. Decide only after pulling a digest of the discussion."

**researcher.md** — "You gather evidence: read code, run experiments, survey
options. Post findings as conclusions with file references, never raw dumps."

**critic.md** — "You attack proposals: edge cases, failure modes, unstated
assumptions. A proposal you cannot break earns an explicit pass."

## Where this is going (phase 2)

A declarative role manifest the orchestration reads directly:

```yaml
# orphus.roles.yaml
task: rate-limiter-design
room: design
roles:
  planner:    { provider: anthropic, model: claude-opus,  brief: roles/planner.md }
  researcher: { provider: openai,    model: gpt-fast,     brief: roles/researcher.md }
  critic:     { provider: xai,       model: grok,         brief: roles/critic.md }
budgets:
  digest: 2000
  perMessage: 600
```

One command fans this out across Orca worktrees (or plain terminals), each
session launched with its model and brief, all joined to the room. The manifest
is also the reproducibility artifact for the book: same roles, same models,
same budgets — rerun the deliberation.
