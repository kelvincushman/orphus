---
name: release
description: "Release Orphus end to end — prove the base is ready, then drive the existing publish-release workflow that writes the changelogs, tags, and publishes. Use when asked to release, publish, ship, cut, or tag a version of Orphus (\"release 2.2.0\", \"cut a release\", \"publish a prerelease\", \"ship this\"), or when asked what still blocks a release. Do not use for releasing anything other than this repository."
metadata:
  internal: true
---

# Releasing Orphus

Almost all of this is already built. Your job is the part that is not: proving
the base is ready, then handing off. **Never reimplement a step below.**

A release here is a **GitHub Release carrying Linux x64, macOS arm64 and
Windows x64 archives, and nothing else.** `release.yml` publishes to no
registry, and `publish.yml` — which would have — is disabled at the repository
level. Never tell anyone a version reached npm.

| Step | Owned by |
| --- | --- |
| `[Unreleased]` → version section, PR, CI watch, merge, tag, publish watch | `publish-release` workflow (`.atomic/workflows/publish-release.ts`) |
| Stamping the version on a detached `Release <version>` commit | `scripts/cut-release.ts`, run by that workflow |
| Building the artifacts | `.github/workflows/release.yml`, started by the tag push |
| Sweeping `packages/coding-agent/docs` and opening a docs PR | `release-docs` workflow |

## 1. Prove the base is ready

`publish-release` requires a **changelog-only diff**, so the docs, the README
and the `[Unreleased]` entries must already be on the base before it starts.
Run the gate first, naming every pull request you believe is in this release by
**its commit on the base** — this repository squash-merges, so a merged PR's
head is never an ancestor of `main` and passing it fails a release that is
ready:

```sh
bun run scripts/release-preflight.ts --base main --expect <merge-sha>
```

It fails when the base has nothing new since the last release, when an
`--expect` commit is not an ancestor of the base, or when a changed package
records nothing in its changelog since the last release. Entries already
stamped under the version being cut count — that is the shape the release
itself requires. **A person saying a pull request is merged is not
evidence it is merged** — a 2.2.0 release was nearly cut from a base whose
feature PR was still open. Check, then say what you found.

Fix what it reports before going on:

- **Not an ancestor** → check you passed the base's commit and not the PR head; if you did, the PR is unmerged. Stop and say so. Do not merge it yourself.
- **Records nothing in its changelog** → write the entries, or establish the change is infrastructure under the Changelog rules in `CLAUDE.md` and say which.
- **Warning that no doc changed** → reread `README.md`, `docs/`, and `packages/coding-agent/docs/` as a new user against what the base now does. The test is not "did I add docs", it is **would someone following the current docs now be misled?** `release-docs` covers `packages/coding-agent/docs` only; the README and root `docs/` are yours.

Land any of those as an ordinary PR and merge it **before** step 3.

## 2. Choose the version

Read the `[Unreleased]` sections you just verified and propose the number:
breaking changes → major, new features → minor, fixes only → patch. State the
reasoning in one line and let the user correct it. Stable is
`MAJOR.MINOR.PATCH`; a prerelease is `MAJOR.MINOR.PATCH-alpha.REVISION` from
revision 1. Ask only when no version was supplied, or when the one supplied is
invalid or ambiguous about kind.

## 3. Hand off

Launch exactly one `publish-release` run with `target_version`, `release_kind`
and `base_ref` (default `main`). It does everything from the changelog PR to
watching the `release.yml` run the tag push starts. Do not duplicate its git,
PR, tag or publishing actions inline, and do not launch a second run. For a
non-`main` base, first require that branch to be protected with the
repository's required checks.

If it stops, it stops with evidence. Report that evidence rather than retrying
around it.

## 4. Finish the release

Neither workflow owns these:

- **Release notes.** The GitHub release body is written from the version's changelog sections — what changed and why it matters, in the register of the previous releases. No invented numbers: every figure must trace to something in the repository.
- **www.orphus.dev.** The site mirrors docs from `main`; sync it after the tag so the changelog page and any new pages match the release. Sync from a checkout of `main`, never from a feature branch.

## Never

- Never run `scripts/cut-release.ts`, `scripts/bump-version.ts`, or `release.yml` by hand during a normal release — the tag push is the publication signal.
- Never bump a version on a release base. `main` stays at the `0.0.0` placeholder; only the detached release commit carries a real version.
- Never edit an already-released changelog section. They are immutable.
- Never force-push, re-tag, or re-run publication to get past a failure.
- Never claim a release is published without the `Release` run's own result, and never describe it as published to a registry.
