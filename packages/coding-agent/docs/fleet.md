# Fleets

A fleet is a reusable, shareable orchestration: named **teams** of agents with
pre-assigned **skills**, bound to a delegation mode, run by one command. The
orchestrator session routes work — deliberation happens in roundtable rooms,
execution fans out through subagents — and every seat runs on a model from the
subscriptions you actually have configured.

One blueprint file is the whole artifact. Share a fleet by sharing the file.

## Quickstart

```
/fleetsetup
```

The session interviews you — outcome, teams, members, models — and writes
`.orphus/fleets/<name>.fleet.yaml`, validating as it goes. Model seats are
offered **only from configured providers** (the same auth the `/login` screen
shows); if you want a provider that isn't configured, run `/login <provider>`
first.

```
/fleet                       # list blueprints
/fleet coding-team add a --version flag to the exporter
/fleet validate coding-team  # check without running
```

Running a fleet pins the blueprint's orchestrator model (if declared), names
the session, and hands the model the fleet's facts plus the
`fleet-orchestration` skill. From there the orchestrator routes: it does not
write the code itself.

## Blueprints

```yaml
name: coding-team
description: Design deliberation, bounded dispatch, adversarial review.
orchestrator:
  model: anthropic/claude-opus     # optional — your choice at setup, never assumed
teams:
  design:
    mode: deliberate               # debate in a room, converge on FINAL: lines
    rounds: 2
    members:
      - agent: codebase-analyzer
      - agent: worker
        brief: Argue for the smallest change that works.
  implementation:
    mode: dispatch                 # parallel bounded tasks, results return
    skills: [tdd]                  # team skills union into every member
    group: true
    members:
      - agent: worker
        count: 2
pipeline: [design, implementation]
```

Members reference agent definitions by runtime name — the agent file keeps
ownership of tools, prompts, and model ladders; the blueprint adds team
structure, briefs, and skill assignments on top. Three modes: `dispatch`,
`deliberate`, and `deliberate-then-dispatch` (decide in a room, then execute
the decision). The full field reference ships as `SCHEMA.md` in the fleet
package, and six example blueprints (coding, design, research, docs/release,
media via Kie.ai, and a blog pipeline) ship in its `examples/`.

Blueprints live in `.orphus/fleets/` (project) and `<agentDir>/fleets/`
(user); project shadows user. The `fleet` tool gives the model
`list`/`get`/`validate` over them — `validate` is the authoring loop's gate.

## Sharp edges

- A `skill` list on a dispatch call **replaces** the agent definition's own
  skills; blueprint unions are computed from the blueprint alone.
- Deliberate-team members need agents whose `tools:` allowlist includes
  `roundtable` (or omits `tools:` entirely) — otherwise they cannot join the
  room.
- Every member is a live model session; `count` and `concurrency` multiply
  real spend. The orchestration skill requires the model to state cost before
  large fan-outs, and caps retries at retry → diagnostic → human.
