---
title: "Overview"
description: "Orphus documentation overview"
---

# Orphus Documentation

Orphus is the loop engine for all engineering work: a terminal coding-agent runtime for reliable, inspectable engineering loops. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, workflows, subagents, MCP, web access, and Orphus packages.

## Quick start

Install Orphus globally with npm, pnpm, or Bun:

With npm:

```bash
npm install -g @orphus/coding-agent
```

With pnpm:

```bash
pnpm add -g @orphus/coding-agent
```

With Bun:

```bash
bun add -g @orphus/coding-agent
```

Orphus does not require package install scripts. If you want to disable dependency lifecycle scripts during the Orphus install, you can add `--ignore-scripts` to the install command.

Or download an `atomic-*` archive from the Orphus GitHub Release for your platform.

### Alpine and musl Linux archives

Alpine Linux x64 and arm64 users can download `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. These archives include native search and PTY bindings. Install the required runtime libraries before running an archive:

```bash
apk add --no-cache libgcc libstdc++
```

The musl archives deliberately omit a clipboard native binding because `@mariozechner/clipboard` 0.3.9 publishes metadata-only musl stubs without a `.node` payload; Orphus uses Linux clipboard commands and OSC52 fallback instead. They also omit `@embedded-postgres/*` binary packages because those packages are glibc-linked. Durable workflows on Alpine therefore require external Postgres via `DBOS_SYSTEM_DATABASE_URL` or Docker; without a durable backend, Orphus uses a loud non-durable in-memory fallback.

Then run it in a project directory:

```bash
atomic
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Orphus.

For the full first-run flow, see [Quickstart](/quickstart).

## Start here

- [Quickstart](/quickstart) - install, authenticate, and run a first session.
- [Using Orphus](/usage) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](/providers) - subscription and API-key setup for built-in providers.
- [Environment variables](/environment-variables) - Orphus/Pi aliases, provider credentials, and bash session metadata.
- [Security](/security) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](/containerization) - sandbox Orphus with OpenShell, Gondolin, or Docker.
- [Settings](/settings) - global and project settings.
- [Keybindings](/keybindings) - default shortcuts and custom keybindings.
- [Sessions](/sessions) - session management, branching, and tree navigation.
- [Compaction](/compaction) - Verbatim Compaction, context management, and branch summarization.

## Customization

- [Extensions](/extensions) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](/skills) - Agent Skills for reusable on-demand capabilities.
- [Subagents](/subagents) - focused child agents for research, analysis, debugging, cleanup, and review compositions.
- [Workflows](/workflows) - executable engineering loops with tracked stages, artifacts, gates, and resumable runs.
- [Prompt templates](/prompt-templates) - reusable prompts that expand from slash commands.
- [Themes](/themes) - built-in and custom terminal themes.
- [Orphus packages](/packages) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](/models) - add model entries for supported provider APIs.
- [Custom providers](/custom-provider) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](/sdk) - embed Orphus in Node.js applications.
- [RPC mode](/rpc) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](/json) - print mode with structured events.
- [TUI components](/tui) - build custom terminal UI for extensions.

## Reference

- [Session format](/session-format) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](/windows)
- [Termux on Android](/termux)
- [tmux](/tmux)
- [Terminal setup](/terminal-setup)
- [Shell aliases](/shell-aliases)

## Development

- [Development](/development) - local setup, project structure, and debugging.
