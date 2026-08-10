---
name: minting-clis
description: Use when a task needs an external API or service and no installed tool serves it well — find or mint an agent-native CLI instead of hand-rolling curl calls or adding an MCP server.
---

# Minting agent-native CLIs

A CLI costs no context until invoked: discovery is `--help` on demand, and
agent-native CLIs add `--agent` JSON output plus local mirrors that collapse
multi-call workflows into one command. An MCP server's tool schemas ride the
context window every turn, used or not. Prefer the CLI.

## The order of moves

1. **Reuse before creation.** Check what is already installed (`command -v`,
   the skill list), then the community library —
   [printing-press-library](https://github.com/mvanhorn/printing-press-library),
   45+ prebuilt agent-native CLIs. A hit installs like any pack; stop here.
2. **Mint.** With the factory installed, run `/skill:printing-press
   <app-name>` and follow its flow. Inputs: an OpenAPI spec, a HAR capture,
   or a URL. Outputs: a Go CLI, an MCP server, and skills teaching its use.
3. **Wrap MCP only when a CLI cannot exist** — stateful push protocols, or
   interactive auth owned by another host.

## If the factory is missing

Both installs are user-visible; say what you are running and why:

```sh
orphus install https://github.com/mvanhorn/cli-printing-press
go install github.com/mvanhorn/cli-printing-press/v4/cmd/cli-printing-press@latest
```

Go absent → STOP and ask the user to install Go 1.26.5+; the toolchain is
their decision, not yours.

## Sharp edges

- **Verify before spending.** Minted CLIs ship a `doctor` command — run it
  before any call that costs credits or money.
- **Credentials never touch a file.** Env vars or the CLI's own `auth`
  command, set by the user — never pasted into chat, never committed.
- **A minted CLI belongs upstream.** The `/skill:printing-press-publish`
  flow contributes it to the community library once it proves out.
