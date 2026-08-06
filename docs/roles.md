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

> Join roundtable room `#<room>`. Post conclusions, not transcripts. Pull a
> digest before major decisions. Your role name is `<role>`.

**`--name` is what makes a role a role.** The roundtable extension takes its room
identity from the session name (`pi.getSessionName()`), and falls back to
`session-<pid>` when none is set — which silently costs the role its broker-side
cursor across restarts. Always pass `--name <role>`; in Orca, name each worktree
after its role too.

`--append-system-prompt` accepts *either* a file path or literal text and may be
repeated, so the brief and the generated footer go in as two separate flags —
the brief stays a file you edit, the footer stays generated. One caveat worth
knowing: a path that does not exist is treated as literal prompt text (with a
warning), so a typo'd brief path becomes the role's system prompt instead of
failing. The manifest loader checks brief existence up front for that reason.

## Example role briefs

**planner.md** — "You decompose the task, assign questions to the room, and own
the final decision. Decide only after pulling a digest of the discussion."

**researcher.md** — "You gather evidence: read code, run experiments, survey
options. Post findings as conclusions with file references, never raw dumps."

**critic.md** — "You attack proposals: edge cases, failure modes, unstated
assumptions. A proposal you cannot break earns an explicit pass."

**librarian** *(phase 3)* — the only role allowed to write long-term memory:
it ingests concluded room transcripts into the
[Dossier wiki](memory.md) and runs the consolidation pass. Every other role
queries read-only. One writer is what keeps shared memory free of write
contention and gives every memory change a single accountable diff.

## The role manifest

Writing those command lines by hand is how a deliberation stops being
reproducible. `orphus.roles.yaml` declares the whole roundtable:

```yaml
task: rate-limiter-design
room: design

roles:
  planner:    { provider: anthropic, model: claude-opus, brief: roles/planner.md }
  researcher: { provider: openai,    model: gpt-fast,    brief: roles/researcher.md }
  critic:     { provider: xai,       model: grok,        brief: roles/critic.md }

budgets:
  digest: 2000
  perMessage: 600
```

`orphus-roles` turns it into launch commands:

```bash
orphus-roles                      # review the plan (default)
orphus-roles --format tmux | sh   # fan out locally, one window per role
orphus-roles --format orca | sh   # fan out across Orca worktrees
orphus-roles --format json        # for your own orchestrator
orphus-roles --format sh          # one line per role, paste into terminals
```

Each role becomes:

```bash
orphus --name planner --provider anthropic --model claude-opus \
  --append-system-prompt /abs/path/roles/planner.md \
  --append-system-prompt '<generated coordination footer>'
```

### Fields

| Key | Required | Meaning |
|---|---|---|
| `task` | yes | Names the run; also the default tmux session name |
| `room` | yes | Room every role joins unless it overrides |
| `roles.<name>.provider` / `.model` | yes | The model behind the role |
| `roles.<name>.brief` | no | Path to the brief, relative to the manifest |
| `roles.<name>.room` | no | Join a different room than the default |
| `roles.<name>.cwd` | no | Working directory (default: manifest directory) |
| `roles.<name>.worktree` | no | Orca selector for `--format orca` (default: `active`) |
| `budgets.digest` / `.perMessage` | no | Defaults 2000 / 600 |

Role and room names must be alphanumeric (with `-`/`_`): they key broker-side
cursors, so a renamed role is a *new* role that has read nothing.

### What the budgets do, precisely

The budgets are the defaults each role is *instructed* to use in its footer.
They are not a runtime ceiling — the hard bound lives in `buildDigest`, which
the `roundtable` tool applies per call, and which no prompt can talk its way
past. Recording the budgets in the manifest is what makes two runs comparable.
Wiring the tool to read a manifest default directly is the natural next step.

### Design notes

- **The planner emits, it does not spawn.** Every role is an interactive model
  session with real cost, so the fan-out stays an explicit act — you pipe to
  `sh`. It also keeps the launcher deterministic and testable end to end.
- **Brief paths are emitted absolute**, because Orca worktrees each have their
  own working directory and a relative path would resolve differently (or, worse,
  become literal prompt text) in each one.
- **Brief first, footer last**, so the room rules are the last word in the prompt.
- **Everything is shell-quoted.** Footers are multi-line prose containing quotes
  and `#`; unquoted they would truncate at the first space and silently change a
  role's instructions.

The manifest is the reproducibility artifact for the book: same roles, same
models, same budgets — rerun the deliberation.
