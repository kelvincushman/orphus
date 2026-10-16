# Changelog

## [Unreleased]

### Fixed

- **Rooms start in the compiled release binary.** Every `roundtable` call from a release `orphus` failed with `Roundtable broker did not start in time`. Under Bun the broker is spawned as `process.execPath <broker/main.ts>`. In a bun-compiled executable `process.execPath` is the `orphus` CLI itself, which ignores the script, starts another agent session, and never opens the broker socket. The broker is now spawned with `BUN_BE_BUN=1`, which makes the compiled binary behave as plain bun and run the script; plain bun and Node launches are unchanged. The intercom broker was not affected: it already launches through the binary's own `--atomic-internal-intercom-broker` entry point.

## [2.3.0] - 2026-09-20

### Added

- **A `memory` skill is bundled beside the `memory` tool.** It carries the discipline the tool's contract implies but never spelled out for the agent: recall is evidence rather than certainty, so `doctor` before trusting an empty `query`, verify a recalled claim against the repository before acting on it, let a later correction beat an older better-matching note, and never treat a recalled note as authorization. Writes stay with the librarian, from a room export under `raw/` after the room concludes. Facts recalled for a child travel as an asserted `handoff` on a fresh session rather than a forked transcript. Adapted from the recall discipline in ECC's `unified-memory` skill (affaan-m/ECC, MIT), rewritten for the Dossier-backed tool and its explicit-fetch contract.

