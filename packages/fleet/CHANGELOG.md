# Changelog

## [Unreleased]

### Added

- Blueprint members accept a `tools` allowlist that replaces the agent definition's own list for that seat — the lever that lets deliberate members built on read-only agents join rooms (`roundtable` is excluded from most read-only allowlists). All bundled examples now grant room access explicitly; the first live fleet run caught two of three panel members locked out.

- Blueprints can declare a **final gate** (`gate: { reviewers, model }`): the orchestrator waits for the named automated GitHub reviewers (CodeRabbit, Greptile, …) to complete on a PR, triages their findings, then dispatches the configured gate model in fresh context for a pass / fix-first verdict before any merge. `/fleetsetup` asks for this during the interview, and the `fleet-orchestration` skill carries the protocol.

- Initial release of fleet orchestration. Blueprints (`.orphus/fleets/<name>.fleet.yaml`, or `<agentDir>/fleets/` user-globally with project shadowing) declare teams of agent definitions with pre-assigned skills, a delegation mode per team (`dispatch`, `deliberate`, or `deliberate-then-dispatch`), rooms, briefs, per-member models, and an optional pipeline order — validated by a strict fail-fast loader whose every error names the file and key path, with advisory warnings for cost- and room-sharing hazards.
- `/fleet <name> <task>` runs a blueprint: it pins the user's chosen orchestrator model via the session model switch (aborting with `/login` guidance before any turn when credentials are missing), names the lead session for its own broker identity, and injects a rendered run prompt with per-team literal `subagent`/`roundtable` recipes, unique member session names, and team∪member skill unions. Bare `/fleet` lists; `/fleet validate <name>` checks without running.
- `/fleetsetup` authors a blueprint by interview: one briefing has the session model walk the user from outcome to teams to members to models — offering model seats only from providers whose auth is actually configured — then write the YAML and iterate `fleet({ action: "validate" })` until clean.
- The `fleet` tool (`list` / `get` / `validate`) gives the model blueprint introspection; `validate` accepts a `path` for files not yet discoverable.
- Bundled skills: `fleet-orchestration` (the orchestration protocol — route decisions not tokens, acceptance criteria per dispatch, mechanical checks before paid review, cross-family verification, a capped retry ladder) and `kie-ai-media` (the Kie.ai unified media API: env-var auth, async createTask/poll pattern, result retention, rate limits).
- Six example blueprints, parse-tested so they cannot rot: `coding-team`, `design-team`, `research-team`, `docs-release-team`, `media-team` (Kie.ai), and `blog-pipeline` (transcript → research → writing → imagery).
