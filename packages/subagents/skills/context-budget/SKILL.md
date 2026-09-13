---
name: context-budget
description: Audit what fills the context window — system prompt sections, bundled skills, agent descriptions, MCP tool schemas, and the channels that still arrive unbounded — and rank what to cut. Use when a session feels slow or shallow, before adding an MCP server or skill, or when asked how much context headroom is left.
---

# Context budget

Measure, then cut. Orphus already bounds four boundaries in code — the room digest, a parallel return, a chain step's `{outputs.name}` splice, and a parent's `handoff` — so the audit targets the rest: what is loaded every turn, and what still arrives unbounded.

## 1. Measure — never estimate what the runtime can report

```sh
orphus inspect runtime --json
```

- `systemPrompt` — hash, byte length, and a hash per top-level `#` section: the always-loaded cost, section by section (the AGENTS.md chain, agent instructions, skill pointers).
- `tools` — every active tool with its parameter-schema hash. Each schema is paid on every turn; MCP servers are the usual bulk, and a server that wraps a CLI you already have is pure overhead.
- `extensions` — what is registered and by whom.

Per-spawn cost lives elsewhere: `subagent({ action: "list" })` shows each agent's description, and that text rides along with every delegation.

Where the report gives bytes, ~4 characters ≈ 1 token. Say "about"; never report a heuristic as a measurement.

## 2. Rank by cost against use

| Bucket | Test | Action |
| --- | --- | --- |
| Always loaded, always used | referenced by AGENTS.md, or something you run every session | keep; trim the wording |
| Always loaded, rarely used | a skill or MCP server whose trigger fires once a week | put it behind a pointer, or drop the server |
| Arrives unbounded | `task` strings, `context: "fork"`, single and chain returns (truncated only above 200 KB / 5000 lines), tool results (spilled to a file only above 50 000 chars) | reshape — see 3 |

## 3. Reshape with what the runtime already bounds

- A child that needs facts, not history: `context: "fresh"` plus `handoff: { … }` instead of `fork`.
- A large return: `outputMode: "file-only"` or `"digest"`; the transcript stays on disk.
- A deliberation: a roundtable room and one digest, never the members' transcripts.
- Durable knowledge: the `memory` tool, fetched explicitly, never carried around.

## 4. Report

Total always-loaded bytes; the three largest prompt sections; the three largest tool schemas; the top three cuts with the saving each buys. Numbers from the report are measurements — mark everything else as an estimate.

Adapted from ECC's `context-budget` skill (affaan-m/ECC, MIT). Rewritten to measure with `orphus inspect runtime` instead of word counts, and to leave out the boundaries Orphus bounds in code.
