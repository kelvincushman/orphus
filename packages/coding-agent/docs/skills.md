> Orphus can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Orphus implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Bundled skills](#bundled-skills)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Orphus loads skills from:

- Global:
  - `~/.orphus/agent/skills/` (legacy `~/.atomic/agent/skills/` and `~/.pi/agent/skills/`)
  - `~/.agents/skills/`
- Project (only after the project is trusted):
  - `.orphus/skills/` (legacy `.atomic/skills/` and `.pi/skills/`)
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories, `orphus.skills`, or legacy `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- In `~/.orphus/agent/skills/` and `.orphus/skills/` (plus the legacy `.atomic` and `.pi` skill directories), direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.orphus/settings.json` (legacy `.atomic/settings.json` and `.pi/settings.json` is also supported):

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Orphus scans skill locations and extracts names and descriptions
2. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses `read` to load the full SKILL.md (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

### Built-in prompt engineering guidance

The bundled `/skill:prompt-engineer` creates, optimizes, evaluates, and troubleshoots prompts for GPT-5.6, Claude Opus 5, and Claude Fable 5. It teaches a delete-first workflow: preserve outcomes, safety, permissions, evidence, output, and stopping contracts while removing repetition, generic self-checks, and obsolete process scaffolding. For autonomous prompts it recommends a compact `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules` shape, context-dependent tool routing, explicit effort and response-length controls, restrained delegation, grounded progress claims, and documents-first/query-last ordering for long inputs.

The skill no longer recommends response prefilling, which returns an error on Claude 4.6 and later, or visible chain-of-thought as a primary technique. Use explicit output instructions, schemas, tools, or post-processing instead of prefilling. Request conclusions, citations, commands, and observed results rather than reconstructed private reasoning; such requests can trigger Claude Fable 5's `reasoning_extraction` safeguard and force a model fallback.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Bundled skills

Every session ships these. Only their one-line descriptions sit in context; a skill's
body loads when a task matches it, or when you invoke it with `/skill:<name>`.

| Skill | Package | What it does |
| --- | --- | --- |
| `subagent` | subagents | Delegate to builtin or custom subagents — single, chain, parallel, async — hand a cheaper child a bounded `handoff`, and route it cheapest-first. See [Subagents](/subagents). |
| `context-budget` | subagents | Measure what fills the context window with `orphus inspect runtime`, then rank what to cut. |
| `strategic-compact` | subagents | Compact at a phase boundary after writing state down — and reach for rooms, `handoff`, and file-only returns first. See [Compaction](/compaction). |
| `ponytail` | subagents | The laziest solution that works: YAGNI, reuse, stdlib, one line before fifty. `/ponytail lite\|full\|ultra` switches intensity. |
| `tdd` | subagents | Red-green-refactor, with tests that exercise public interfaces rather than internals. |
| `minting-clis` | subagents | When a task needs an API no tool serves: find or mint an agent-native CLI before hand-rolling `curl` or adding an MCP server. See [below](#minting-agent-native-clis). |
| `liteparse` | subagents | Local, model-free extraction from PDF, DOCX, PPTX, XLSX, and image files via the `lit` CLI. |
| `playwright-cli` | subagents | Drive a real browser for end-to-end checks, screenshots, and proof videos. See [Browser](/browser). |
| `tmux` | subagents | Drive tmux sessions, windows, and panes for interactive CLIs. See [tmux](/tmux). |
| `roundtable` | roundtable | Discussion etiquette for rooms: post conclusions not transcripts, digest before deciding, one room per concern. |
| `memory` | roundtable | Recall is evidence, not certainty: query before writing, verify against the repository, hand recall to a child as an asserted `handoff`. |
| `fleet-orchestration` | fleet | The protocol a `/fleet` run follows: route by difficulty down the price curve, converge deliberations, verify dispatch, a capped retry ladder, when to gate on the human. See [Fleets](/fleet). |
| `kie-ai-media` | fleet | Images, video, and audio through the Kie.ai API, for media-team members. |
| `intercom` | intercom | Session-to-session messaging and delegation between agents on one machine. See [Intercom](/intercom). |
| `research-codebase` | workflows | Scoped research that writes a grounded artifact for one subsystem or question. |
| `create-spec` | workflows | Turn research into an implementation-ready plan built around the program's entrypoints. |
| `prompt-engineer` | workflows | Create, optimize, evaluate, or troubleshoot prompts for current frontier models. See [above](#built-in-prompt-engineering-guidance). |
| `impeccable` | workflows | Critique and refine frontend and product UI. |
| `skill-creator` | workflows | Create, improve, and benchmark skills. |

`context-budget`, `strategic-compact`, and `memory` are rewrites of skills from
[ECC](https://github.com/affaan-m/ECC) (MIT) against what Orphus enforces in code — the
runtime-bounded channels, `handoff`, verbatim compaction, the Dossier-backed `memory`
tool — rather than what ECC asks a model to remember. A skill from a community pack
shadows a bundled one of the same name (see [Community skill packs](#community-skill-packs)).

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && bun install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative file paths from the skill directory (these are bundled skill files, not docs routes):

```markdown
See the API reference at `references/api-reference.md` for details.
```

Keep authored instructions outcome-first and concise. State observable completion and stop conditions, give a short reason for material constraints, and use decision rules for judgment calls instead of `ALWAYS`/`NEVER` language. Put detailed or model-specific material in `references/` so it loads only when needed. Do not ask models to reproduce private reasoning or repeatedly verify their own work; require evidence or validation results where correctness matters.

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Orphus validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && bun install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Upstream skill examples for web search, browser automation, Google APIs, and transcription

## Community skill packs

Any git repository containing `SKILL.md` files installs as a pack — nested
layouts are discovered, and skills load lazily like everything else:

```bash
orphus install https://github.com/mattpocock/skills          # engineering workflow suite
orphus install https://github.com/mvanhorn/cli-printing-press # agent-native CLI factory
```

Precedence is user > builtin, and the startup banner reports name collisions
(installing mattpocock/skills shadows the builtin `tdd`, for example — filter
the pack's `skills` list in settings if you want the builtin back). Skills
whose frontmatter sets `disable-model-invocation: true` stay out of the
model's view by their author's design and run only via `/skill:<name>`.

Packs that read repo configuration use the committed-markdown convention
under `docs/agents/` (issue tracker, triage labels, domain docs) — the same
files `/fleetsetup` writes and fleet runs reference. One configuration serves
fleets and skills alike.

## Creating skills — the standard

New skills follow the **writing-for-agents** method (Matt Pocock's, shipped in
the pack above and model-invocable: it surfaces whenever an agent creates or
edits a skill). Its levers, briefly:

- **Context pointers**: a skill's description is a pointer — its *wording*
  decides when the agent reaches the body. Front-load the leading word; one
  trigger per branch; cut identity the body already carries.
- **The two loads**: always-loaded material costs context every turn;
  documents nobody can find cost the human. Spend each deliberately.
- **The information hierarchy**: in-file steps → in-file reference →
  disclosed reference behind a pointer. Inline what every branch needs; push
  behind a pointer what only some branches reach.

Author with `/skill:writing-for-agents` loaded, and prefer deletion to
explanation.

## Minting agent-native CLIs

Every session ships the `minting-clis` skill — it fires when a task needs an
API no installed tool serves, and carries the order of moves (community
library first, mint second, MCP only when a CLI cannot exist). The machinery
it points at: the
[Printing Press](https://github.com/mvanhorn/cli-printing-press) pack mints
one: from an OpenAPI spec, a HAR capture, or a URL, it generates a
token-efficient Go CLI, an MCP server, and skills that teach its use. With
the pack installed and the generator built (`go install
github.com/mvanhorn/cli-printing-press/v4/cmd/cli-printing-press@latest`),
run `/skill:printing-press <app-name>` and follow its flow; 45+ community
CLIs are pre-built in the
[library](https://github.com/mvanhorn/printing-press-library).

