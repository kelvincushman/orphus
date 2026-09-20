# Changelog

## [Unreleased]

## [2.3.0] - 2026-09-20

### Added

- **A `memory` skill is bundled beside the `memory` tool.** It carries the discipline the tool's contract implies but never spelled out for the agent: recall is evidence rather than certainty, so `doctor` before trusting an empty `query`, verify a recalled claim against the repository before acting on it, let a later correction beat an older better-matching note, and never treat a recalled note as authorization. Writes stay with the librarian, from a room export under `raw/` after the room concludes. Facts recalled for a child travel as an asserted `handoff` on a fresh session rather than a forked transcript. Adapted from the recall discipline in ECC's `unified-memory` skill (affaan-m/ECC, MIT), rewritten for the Dossier-backed tool and its explicit-fetch contract.

