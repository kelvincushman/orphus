> Orphus can help you create packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Orphus Packages

Orphus packages bundle extensions, skills, prompt templates, themes, and workflow definitions so you can share them through npm or git. Declare resources in `package.json` under the `atomic` key, or use conventional directories.

## Table of Contents

- [Orphus Packages](#orphus-packages)
  - [Table of Contents](#table-of-contents)
  - [Install and Manage](#install-and-manage)
  - [Package Sources](#package-sources)
    - [npm](#npm)
    - [git](#git)
    - [Local Paths](#local-paths)
  - [Creating an Orphus Package](#creating-an-orphus-package)
    - [Gallery Metadata](#gallery-metadata)
  - [Package Structure](#package-structure)
    - [Convention Directories](#convention-directories)
  - [Dependencies](#dependencies)
  - [Package Filtering](#package-filtering)
  - [Enable and Disable Resources](#enable-and-disable-resources)
  - [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Orphus packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
atomic install npm:@foo/bar@1.0.0
atomic install git:github.com/user/repo@v1
atomic install https://github.com/user/repo  # raw URLs work too
atomic install /absolute/path/to/package
atomic install ./relative/path/to/package

atomic remove npm:@foo/bar
atomic list                     # show installed packages from settings
atomic update                   # update Orphus only
atomic update --all             # update Orphus, update packages, and reconcile pinned git refs
atomic update --extensions      # update packages and reconcile pinned git refs only
atomic update --models          # force-refresh authenticated provider model catalogs
atomic update --self            # update Orphus only
atomic update --self --force    # reinstall Orphus even if current
atomic update npm:@foo/bar      # update one package
atomic update --extension npm:@foo/bar
```

These commands manage Orphus packages and `atomic update` can update the Orphus CLI installation. To uninstall Orphus itself, see [Quickstart](/quickstart#uninstall).

Self-update resolves an exact advertised package/version target and installs that pinned spec, so the update cannot drift to a newer registry release during installation. Any release note supplied by the update service is shown before installation. Orphus only updates installations it can verify are writable and managed by the detected global package manager; otherwise it prints a manual command. On Windows, loaded native dependencies are temporarily quarantined during replacement and stale quarantine directories are cleaned on later update attempts.

By default, `install` and `remove` write to user settings (`~/.orphus/agent/settings.json`). Use `-l` to write to project settings (`.orphus/settings.json`; legacy `.pi/settings.json` is also read) instead. Project settings can be shared with your team, and Orphus installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
atomic -e npm:@foo/bar
atomic -e git:github.com/user/repo
```

For local directories, `-e <dir>` also borrows project-local Orphus resources under `<dir>/.orphus`, legacy `<dir>/.pi`, and `<dir>/.agents/skills` when present. Because borrowed extensions and workflows can execute code, Orphus resolves trust for that extension source before loading those borrowed project-local resources.

Workflows discovered through `-e` keep that same trusted resource set when they create child stage sessions. Stage agents get fresh resource loaders seeded from the parent snapshot, so package tools/extensions, subagents and agent definitions, skills, prompt templates, themes, workflows, and trusted borrowed project-local resources remain available in workflow stages unless the stage supplies its own explicit `resourceLoader`.

## Package Sources

Orphus accepts three source types in settings and `atomic install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`atomic update --extensions`, `atomic update --all`).
- User installs use the configured npm-compatible package-manager command (npm by default) and resolve from the managed Orphus npm area.
- Project installs go under `.orphus/npm/` (legacy `.pi/npm/` remains a compatibility fallback).
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `atomic update --extensions` and `atomic update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `atomic install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.orphus/agent/git/<host>/<path>` (global) or `.orphus/git/<host>/<path>` (project; legacy `.pi/git/` remains a compatibility fallback).
- When reconciliation changes the checkout, Orphus resets and cleans the clone, then runs the configured npm-compatible install command if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
atomic install git:git@github.com:user/repo

# ssh:// protocol format
atomic install ssh://git@github.com/user/repo

# With version ref
atomic install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, Orphus loads resources using package rules. Temporary local directories supplied with `-e` may also expose `.orphus`/`.pi` project-local resources and `.agents/skills` after the extension source is trusted.

## Creating an Orphus Package

Add an app manifest to `package.json` or use conventional directories. The manifest key is the configured app name (`atomic` here, from `atomicConfig.name`; legacy `piConfig.name` is also read). The legacy `pi` key remains supported as a backwards-compatible shim. Include the `atomic-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["atomic-package"],
  "atomic": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "workflows": ["./workflows"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

The package gallery currently recognizes legacy `pi-package` metadata, while new Orphus packages should also include `atomic-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["atomic-package", "pi-package"],
  "atomic": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no app manifest (`atomic`, or legacy `pi`) is present, Orphus auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files
- `workflows/` loads workflow SDK files (`.ts`, `.js`, `.mjs`, `.cjs`); `workflow/` is also accepted as a singular alias. Workflow files should `import { workflow } from "@orphus/workflows"`, import `Type` from `typebox`, and export the `workflow({ ... })` result. TypeScript package authors do not need a hand-authored `.d.ts`, a `declare module` shim, or a `tsconfig` `paths` alias for the SDK import — the SDK types ship with `@orphus/coding-agent`. A package that also imports `@orphus/coding-agent` picks them up automatically; a pure workflow-only package adds one opt-in line (`compilerOptions.types: ["@orphus/coding-agent/workflows/ambient"]` or a `/// <reference types="@orphus/coding-agent/workflows/ambient" />` directive). See the workflow SDK typing guidance under Programmatic Usage in the workflows guide.

When a package manifest exists, declared resource arrays normally define what loads. Workflows are the exception: if `atomic.workflows` / legacy `pi.workflows` is omitted, Orphus still checks conventional `workflows/` and `workflow/` directories.

## Dependencies

Third-party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, themes, or workflows also belong in `dependencies`. When Orphus installs a package from npm or git, it runs the configured npm-compatible install command, so those dependencies are installed automatically.

Orphus bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@orphus/coding-agent`, `@earendil-works/pi-tui`, `typebox`.

Workflow packages should author workflow files with `import { workflow } from "@orphus/workflows"`, `import { Type } from "typebox"`, and export definitions produced by `workflow({ ... })`. Do not use the removed `runWorkflow` object-form API, and do not hand-roll objects with `__piWorkflow: true`; discovery accepts only definitions minted by `workflow({ ... })`. `@orphus/workflows` is not a separate npm package: its types resolve through `@orphus/coding-agent`, so list `@orphus/coding-agent` and `typebox` in `peerDependencies`. A pure workflow-only package also adds the one-line ambient opt-in noted above; a package that imports `@orphus/coding-agent` elsewhere picks the types up automatically.

Package-authored workflows should follow the same guiding principles as project workflows mentioned in docs/workflows.md.

Other Orphus packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Orphus loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "atomic": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"],
      "workflows": ["workflows/*.ts"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `atomic config` to enable or disable extensions, skills, prompt templates, and themes. It starts in global settings (`~/.orphus/agent/settings.json`); press Tab to switch global/project scope. Use `atomic config -l` to start in project overrides (`.orphus/settings.json`) with inherited global resources dimmed. Workflow package filters can be configured with `workflows` patterns.

## Scope and Deduplication

Packages can appear in both global and project settings. The project entry normally wins. A project entry with `autoload: false` instead acts as a delta over the global entry: it starts with no newly auto-discovered resources while explicit include/exclude patterns adjust the inherited package resources. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
