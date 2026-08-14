# Changelog

## [Unreleased]

### Changed

- **Teams accept `deadlineMs` for asynchronous deliberations.** Without one, a deliberation waits on a completion notification a stalled member may never trigger — the observed failure being a panelist that never joins the room at all, leaving the orchestrator idle indefinitely. With one, the run is finalized on expiry and the result names the members still running. It is emitted only on the async call: a `blocking: true` team is bounded by the turn, so pairing the two now warns rather than describing a ceiling nothing enforces.
- **A deliberation no longer blocks the orchestrator's turn.** The rendered `subagent` call now carries `async: true`: it returns a run id immediately, the orchestrator ends its turn, and members converse in the room while it is idle. It wakes on the subagent completion notification for that run id and pulls one digest to synthesize, exactly as before. The orchestrator's context during a deliberation is now a run id, a few coalesced activity pings, and one bounded digest — regardless of how long the members argue. The rendered prompt is explicit that an activity ping means work is happening and **not** that it finished: pings are best-effort by contract, and synthesizing on one would read a half-finished room as a decision. `blocking: true` on a team restores the previous behaviour for a blueprint that depends on it; it has no effect on dispatch teams, which return their own results, and saying so in a blueprint now produces a warning rather than being silently ignored.

## [0.1.0] - 2026-08-11

The first stable Orphus release, and this package's first release of any
kind — fleet orchestration was born in the 0.1.0 prerelease line.

### Changed

- The orchestration skill gains the toolsmith move: a task needing an unserved API dispatches a member with `minting-clis` to find or mint an agent-native CLI, then re-dispatches with the new tool in the brief.
- The kie-ai-media skill prefers `kie-pp-cli` (the community Printing Press CLI for Kie.ai) when it is on PATH — agent-native JSON mode, doctor-verified auth before spending credits — keeping the raw async API pattern as the fallback.

### Added

- Fleet runs adapt to the repository through committed markdown under `docs/agents/` (issue-tracker.md, triage-labels.md, domain.md): `/fleet` references whichever files exist in the run prompt — read lazily, never inlined — and `/fleetsetup` asks one question and writes `issue-tracker.md` when it is missing, proposing the tracker that matches the git remote. The convention is shared with community skill packs (mattpocock/skills reads the same files), so one configuration serves fleets and skills alike.

### Fixed

- Deliberate members are now told the room join is their mandatory FIRST tool call and the room is the deliverable — the second live panel proved an agent's own system prompt can beat a polite protocol (one member researched diligently and never joined). The orchestration skill now also verifies every member posted and reports a silent member as a defect instead of folding its artifact into the synthesis.

- Blueprint members accept a `tools` allowlist that replaces the agent definition's own list for that seat — the lever that lets deliberate members built on read-only agents join rooms (`roundtable` is excluded from most read-only allowlists). All bundled examples now grant room access explicitly; the first live fleet run caught two of three panel members locked out.

- Blueprints can declare a **final gate** (`gate: { reviewers, model }`): the orchestrator waits for the named automated GitHub reviewers (CodeRabbit, Greptile, …) to complete on a PR, triages their findings, then dispatches the configured gate model in fresh context for a pass / fix-first verdict before any merge. `/fleetsetup` asks for this during the interview, and the `fleet-orchestration` skill carries the protocol.

- Initial release of fleet orchestration. Blueprints (`.orphus/fleets/<name>.fleet.yaml`, or `<agentDir>/fleets/` user-globally with project shadowing) declare teams of agent definitions with pre-assigned skills, a delegation mode per team (`dispatch`, `deliberate`, or `deliberate-then-dispatch`), rooms, briefs, per-member models, and an optional pipeline order — validated by a strict fail-fast loader whose every error names the file and key path, with advisory warnings for cost- and room-sharing hazards.
- `/fleet <name> <task>` runs a blueprint: it pins the user's chosen orchestrator model via the session model switch (aborting with `/login` guidance before any turn when credentials are missing), names the lead session for its own broker identity, and injects a rendered run prompt with per-team literal `subagent`/`roundtable` recipes, unique member session names, and team∪member skill unions. Bare `/fleet` lists; `/fleet validate <name>` checks without running.
- `/fleetsetup` authors a blueprint by interview: one briefing has the session model walk the user from outcome to teams to members to models — offering model seats only from providers whose auth is actually configured — then write the YAML and iterate `fleet({ action: "validate" })` until clean.
- The `fleet` tool (`list` / `get` / `validate`) gives the model blueprint introspection; `validate` accepts a `path` for files not yet discoverable.
- Bundled skills: `fleet-orchestration` (the orchestration protocol — route decisions not tokens, acceptance criteria per dispatch, mechanical checks before paid review, cross-family verification, a capped retry ladder) and `kie-ai-media` (the Kie.ai unified media API: env-var auth, async createTask/poll pattern, result retention, rate limits).
- Six example blueprints, parse-tested so they cannot rot: `coding-team`, `design-team`, `research-team`, `docs-release-team`, `media-team` (Kie.ai), and `blog-pipeline` (transcript → research → writing → imagery).
