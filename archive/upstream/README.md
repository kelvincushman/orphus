# Upstream archive

Working notes inherited from [Atomic](https://github.com/bastani-inc/atomic) and, before
it, pi. **None of it was written for Orphus**, and nothing in this repository reads it:
no script, workflow, test, or config resolves a path in here.

It is kept rather than deleted because it is the reasoning behind decisions still visible
in the vendored tree, and `git log` alone does not carry that. Treat it as a reference for
"why is the harness like this", not as documentation of how Orphus works.

## What is here

| Directory | Contents |
| --- | --- |
| `specs/` | 129 flat `YYYY-MM-DD-slug.md` files, Jan–Aug 2026. Several filenames are auto-generated from GitHub issue URLs and truncated mid-word; some point at `flora131/atomic`, an organization that predates `bastani-inc`. |
| `research/` | 254 files. `docs/` holds the same dated-markdown convention; `designs/`, `subagents/`, `tickets/`, and `web/` hold prototypes and library research; the loose `upstream-*.diff`, `*-name-status.txt`, and `pr-*.json` files are raw command output captured during upstream porting. |

Neither directory has an index, and finding anything means grepping.

## Why they moved

They sat at the repository root, where they read as current project material — the first
two directories after `packages/` in a listing. `PLAN.md`'s thesis is that the evidence
trail *is* the deliverable, so root-level `specs/` and `research/` are exactly where a
reader expects Orphus's own decisions to be, and finding 383 files of someone else's is
worse than finding nothing.

Moving them also frees those two names. Several shipped workflow skills write there by
convention — `create-spec` outputs to `specs/`, `research-codebase` outputs to
`research/docs/` and `research/web/` — so a fresh `specs/` or `research/` at the root is
now unambiguously this project's output rather than a mix.

## Adding to this

Don't. New Orphus specs and research belong at the repository root, in the directories
this move vacated. This archive is a snapshot, and it should only ever shrink — a file
here becomes worth keeping when someone extracts what is still true into a live document.
