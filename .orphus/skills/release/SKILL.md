---
name: release
description: "Release Orphus end to end — prove the base is ready, then drive the existing publish-release workflow that writes the changelogs, tags, and publishes. Use when asked to release, publish, ship, cut, or tag a version of Orphus (\"release 2.2.0\", \"cut a release\", \"publish a prerelease\", \"ship this\"), or when asked what still blocks a release. Do not use for releasing anything other than this repository."
metadata:
  internal: true
---

# Releasing Orphus

Almost all of this is already built. Your job is the part that is not: proving
the base is ready, then handing off. **Never reimplement a step below.**

| Step | Owned by |
| --- | --- |
| `[Unreleased]` → version section, PR, CI watch, merge, tag, publish watch | `publish-release` workflow (`.atomic/workflows/publish-release.ts`) |
| Stamping the version on a detached `Release <version>` commit | `scripts/cut-release.ts`, run by that workflow |
| Building and publishing the artifacts | `.github/workflows/publish.yml`, started by the tag push |
| Sweeping `packages/coding-agent/docs` and opening a docs PR | `release-docs` workflow |

## 1. Prove the base is ready

`publish-release` requires a **changelog-only diff**, so the docs, the README
and the `[Unreleased]` entries must already be on the base before it starts.
Run the gate first, naming the head commit of every pull request you believe is
in this release:

```sh
bun run scripts/release-preflight.ts --base main --expect <pr-head-sha>
```

It fails when the base has nothing new since the last release, when an
`--expect` commit is not an ancestor of the base, or when a changed package has
no `[Unreleased]` entries. **A person saying a pull request is merged is not
evidence it is merged** — a 2.2.0 release was nearly cut from a base whose
feature PR was still open. Check, then say what you found.

Fix what it reports before going on:

- **Not an ancestor** → the PR is unmerged. Stop and say so. Do not merge it yourself.
- **Missing `[Unreleased]` entries** → write them, or establish the change is infrastructure under the Changelog rules in `CLAUDE.md` and say which.
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
watching `Publish <version>` to completion. Do not duplicate its git, PR, tag
or publishing actions inline, and do not launch a second run. For a non-`main`
base, first require that branch to be protected with the repository's required
checks.

If it stops, it stops with evidence. Report that evidence rather than retrying
around it.

## 4. Finish the release — every surface, in order

A release is not the tag. It is the tag plus every place a person finds out what
changed. The gate in step 1 prints these as **Release surfaces** and warns on the
ones it can see; the last three live outside this repository, so they are steps
here rather than checks there.

| Surface | Owner | Done when |
| --- | --- | --- |
| Changelogs | `publish-release` | `[Unreleased]` is now a version section |
| README | you, before step 1 | someone following it is not misled |
| Documentation | you, before step 1 | same test, for `docs/` and `packages/coding-agent/docs/` |
| GitHub release | you, after the tag | body written from the version's changelog sections |
| **www.orphus.dev** | you, after the tag | synced from `main`, built, pushed |
| **LinkedIn + X** | you, after the site | drafted, shown to the user, posted by them |

**The GitHub release body** is written from the version's changelog sections —
what changed and why it matters, in the register of the previous releases. No
invented numbers: every figure must trace to something in the repository.

**www.orphus.dev** mirrors `main`. Sync from a checkout of `main`, never a
feature branch:

```sh
ORPHUS_LOCAL=/path/to/main/checkout npm run sync && npm run build
```

Check the sync's own output before committing. It warns when an indexed page is
not mirrored, and when the GitHub API refused and `stars` kept a stale value.
The banner and the changelog note read the version from `meta.json`, which the
sync derives from `RELEASE_NOTES.md` — so they follow the release automatically,
and a hand-typed version anywhere on the site is a bug, not a task.

**The announcement.** One LinkedIn post and one X post per stable release;
prereleases get neither. Draft both, show them to the user, and let them post —
never post on their behalf.

What an Orphus post is:

- **One idea, the one a reader could not have guessed.** Not a feature list.
  System One's idea is "ask a cheap question before spending a model turn, and
  defer whenever it is unsure"; rooms' idea is "deliberation that does not cost
  context window".
- **Every number traceable.** Same rule as the release body. "32% of raw
  transcript cost" is on the site because a committed demo measures it and CI
  fails if it regresses. If a figure cannot be traced, cut it.
- **Honest about what is not done.** The abstain band is not calibrated; say so.
  A post that oversells is the one that gets quoted back.
- **LinkedIn**: a short paragraph or two, the idea and why it matters, a link to
  the release. **X**: one post, the idea in its first line, the link last. No
  hashtag spam, no thread unless the content genuinely needs one.

## Never

- Never run `scripts/cut-release.ts`, `scripts/bump-version.ts`, or `publish.yml` by hand during a normal release — the tag push is the publication signal.
- Never bump a version on a release base. `main` stays at the `0.0.0` placeholder; only the detached release commit carries a real version.
- Never edit an already-released changelog section. They are immutable.
- Never force-push, re-tag, or re-run publication to get past a failure.
- Never claim a release is published without the `Publish <version>` run's own result.
