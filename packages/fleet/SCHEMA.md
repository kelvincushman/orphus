# Fleet blueprint schema (version 1)

One YAML file = one shareable fleet: `.orphus/fleets/<name>.fleet.yaml` (project)
or `<agentDir>/fleets/` (user; project shadows). Validation is strict — unknown
keys fail, and every error names the file and key path.

```yaml
name: coding-team          # required; [a-z0-9][a-z0-9_-]*; names default rooms + the lead session
description: One line.     # required
version: 1                 # optional; only 1 exists

orchestrator:              # optional
  model: anthropic/claude-opus   # provider/model for the lead session; must be a configured provider

defaults:                  # optional
  concurrency: 4           # dispatch fan-out width; >4 warns, >50 fails
  budgets:
    digest: 2000           # roundtable digest character budget
    perMessage: 600        # per-message verbatim cap inside a digest

teams:                     # required; at least one
  <team-name>:             # [a-z0-9][a-z0-9_-]*
    mode: deliberate       # required: dispatch | deliberate | deliberate-then-dispatch
    room: my-room          # optional; default fleet-<fleet>-<team>; explicit duplicates warn (they merge)
    topic: One line.       # optional; shown when the room is created
    rounds: 2              # optional; digest/reply rounds per deliberating member (max 10); ignored by dispatch
    skills: [tdd]          # optional; unioned into EVERY member's skills
    group: true            # optional; intercom group for dispatch sets — true = one shared auto group
    concurrency: 2         # optional per-team override
    members:               # required; at least one; expansion (sum of counts) capped at 50
      - agent: worker      # required; an agent definition's runtime name (dots ok: package.name)
        brief: |           # optional; inline role brief — XOR briefPath
          One paragraph of role contract.
        briefPath: briefs/x.md   # optional; relative to this file; must exist and be readable
        skills: [coding-standards]  # optional; unioned with team skills
        model: openai-codex/gpt-fast # optional; overrides the agent definition's model
        count: 2           # optional; dispatch replication — members get unique session names

pipeline: [design, implementation]  # optional; suggested team order; defaults to declaration order

gate:                      # optional; the final gate for work that lands as a PR
  reviewers: [coderabbit]  # automated GitHub reviewers that must COMPLETE before merging
  model: openai-codex/gpt-5.6-sol  # the final-verdict reviewer, dispatched after they finish
```

Sharp edges the validator cannot fully see for you:

- A `skill` list passed at dispatch **replaces** the agent definition's own
  skills — restate anything the member must keep.
- An agent definition whose `tools:` allowlist omits `roundtable` cannot join
  rooms: deliberate-team members need agents that either omit `tools` or
  include it.
- Every member is a live model session; `count` and `concurrency` multiply real
  spend.
