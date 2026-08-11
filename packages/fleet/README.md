# @orphus/fleet

Community-shareable fleet orchestration for Orphus. A blueprint
(`<name>.fleet.yaml`) binds teams of agent definitions — with pre-assigned
skills — to deliberation rooms and dispatch fan-out; `/fleet <name> <task>`
runs one, `/fleetsetup` authors one by interview, and the `fleet` tool gives
the model `list`/`get`/`validate` introspection.

The extension executes nothing itself. Members are spawned by the model
through the existing `subagent` tool (whose per-task `name` keeps broker
identities distinct), deliberation happens in roundtable rooms, and the
orchestration protocol lives in the bundled `fleet-orchestration` skill —
ported from the proven fable-fleet setup: route decisions not tokens,
acceptance criteria per dispatch, mechanical checks before paid review,
cross-family verification, and a capped retry ladder.

- Schema reference: [SCHEMA.md](SCHEMA.md)
- Examples: [examples/](examples/) — coding, design, research, docs/release,
  media (Kie.ai), and a blog-from-YouTube pipeline
- User docs: `packages/coding-agent/docs/fleet.md`

Ships as raw TypeScript with no build step, like every Orphus companion
package.
