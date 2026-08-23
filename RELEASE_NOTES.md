# Orphus 2.0.0

**Many minds, from many makers, argue at one table — the best path leaves the room.**

Orphus 2.0 is the release where the runtime becomes *verifiable*: every provider request is recorded exactly as sent, the assembled runtime can be inspected and diffed, three context boundaries are now bounded by code rather than convention — and the full inherited test suite (3,084 tests) is green and gating every change.

## Highlights

### The harness records what it actually sent
Every provider request is written to the session at the last point before dispatch — after every hook, after sanitization — with the exact body, its SHA-256, retry attempt, and turn. A request whose record cannot be written fails *before* it reaches the network, because a dispatch nothing recorded is a dispatch nothing can replay. Responses, tool-call audits, and per-tool context accounting close the loop. Credentials are never recorded; only a credential's label can ever appear. `orphus inspect runtime --json` prints a deterministic report of the resolved model, tools, extensions, hook order, and system-prompt section hashes — two runs of the same configuration are byte-identical, so a diff is a real difference.

### Three bounded boundaries, one core
The room digest's contract — a fixed budget spent newest-first, the rest degraded to headlines and a count — now also bounds a **parallel subagent fan-out's return** and a **chain step's `{outputs.name}` splice**, through the same `boundedRender` core so the boundaries cannot drift apart. Four children emitting 100 KB each reach the parent as roughly 1.7 KB with every task named, failures ordered first, and every line pointing at the full output on disk. Subagent nesting now defaults to two levels (the ceiling stays five, one opt-in away).

### Fleets deliberate without holding the orchestrator hostage
A deliberation now runs async: the orchestrator gets a run id, ends its turn, and wakes on completion to pull one bounded digest — its context during a long argument is a run id, a few pings, and one digest. Teams accept `deadlineMs`, so a stalled panelist finalizes the run naming who never finished instead of hanging it forever. The `ponytail` discipline skill ships bundled in every session.

### Browser operation, twice-gated
An action-dispatched `browser` tool behind `ORPHUS_ENABLE_BROWSER` — each session gets its own throwaway Chrome that carries none of your cookies. Login is a second, separate switch with an origin allowlist, per-origin human approval, and OS-keychain storage; an unattended run cannot authorize its own credential use. With the switches off, the tool does not exist.

### A second terminal renderer, opt-in
`ORPHUS_TUI_BACKEND=termdom` runs startup selection and the `--resume` picker on termDOM (real HTML/CSS layout in the terminal), with structural parity to the pi renderer through one shared selector model. The default remains `pi`; the chat shell is unchanged.

### Local dictation, honestly not enabled
`@orphus/transcribe` lands the full worker/helper protocol, ABI verification, and a consent-then-checksum model catalog — and both channels fail closed until the native artifacts are built. The guard is the feature: nothing loads a model you did not verify.

### Hardened by audit
The security/robustness audit (#85) closed out across five PRs: the roundtable broker socket comes up owner-only (`0600`), a wedged broker startup names the stale lock and its dead owner, `/fleetsetup` strips credentials from git remotes before briefing, self-update follows release channels (a stable install is never dragged onto a beta), and the installer keeps the previous version for rollback while pruning older ones.

### A suite you can trust
The coding-agent workspace suite — 385 files, red since the fork began — is fully green and now gates every pull request, through a wrapper that enforces per-test duration budgets. Test runs are hermetic against ambient provider credentials (a configured AWS CLI can no longer make "no models available" fixtures see a 114-model catalog). Two real bugs the suite caught are fixed: the in-app changelog no longer rewrites upstream attribution links into dead ones, and OpenRouter attribution identifies Orphus rather than Atomic's site.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kelvincushman/orphus/main/install.sh | sh
```

macOS arm64 and Linux x64 (glibc 2.27+) archives, checksum-verified. Upgrading later is `orphus update`. Pin this release with `install.sh --ref v2.0.0`.

Try the context-window contract with no model and no API key: clone the repo and run `npm run demo` — a late-joining reviewer catches up on a 9-message discussion for a third of the transcript's cost, asserted, not narrated.

## Full changelogs

Per-package details live in `packages/*/CHANGELOG.md` under the `2.0.0` sections — the coding-agent changelog alone carries fifty-plus entries for this release.

## Lineage

Orphus builds on [Atomic](https://github.com/bastani-inc/atomic) (MIT), itself a fork of the pi agent harness. The vendored tree stays close to upstream so improvements keep flowing both ways.
