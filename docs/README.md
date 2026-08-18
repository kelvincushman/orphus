# Orphus documentation

Orphus is a coding agent whose agents can hold a discussion that does not live in
any of their context windows. Start with the first link; the rest are reference.

## Start here

| | |
| --- | --- |
| **[Getting started](getting-started.md)** | Clone to working fleet, in five tiers. Tier 1 needs no model and no API key. |
| **[Troubleshooting](troubleshooting.md)** | The three failures that look like success, and everything else that goes wrong. |

## Using it

| | |
| --- | --- |
| **[The `roundtable` tool](roundtable-tool.md)** | Every action, parameter, and default, with the reasoning. |
| **[Roles and the manifest](roles.md)** | Declaring a fleet in `orphus.roles.yaml` and turning it into launch commands. |
| **[Memory](memory.md)** | The durable layer: the librarian convention, the export → ingest → query flow, and its contract. |
| **[Fleets](../packages/coding-agent/docs/fleet.md)** | Blueprint-driven orchestration: teams with pre-assigned skills, run by `/fleet`, authored by `/fleetsetup`. |
| **[Orca integration](orca-integration.md)** | Running a fleet across parallel git worktrees. |
| **[Workflow playbook](workflow-playbook.md)** | Multi-stage workflow execution, inherited from Atomic. |
| **[The refine loop](refine.md)** | `/refine` — gated, reversible self-modification: what the gate refuses, and what it does not claim. |
| **[Execution kernels](repl.md)** | `repl` — values that outlive a tool call. **Not a security sandbox**, and honest about which pieces are wired. |
| **[Interactive browsing & the credential vault](../packages/web-access/README.md#interactive-browsing-and-the-credential-vault)** | The `browser` tool (CDP-driven open/read/click/type/login) and the `/credential` vault, both gated off by default. Design: [web-operation design](superpowers/specs/2026-08-16-orphus-web-operation-design.md) and the [web-automation methodology](superpowers/web-automation-methodology.md) it follows. |

## Understanding it

| | |
| --- | --- |
| **[Architecture](architecture.md)** | What runs where, what the bound actually guarantees, and where the trust boundary sits. |
| **[Design decisions](../packages/roundtable/DESIGN.md)** | Why each choice went the way it did, including the alternatives rejected. |
| **[The self-improvement loop](self-improvement-loop.md)** | The design behind [refine](refine.md). Collect, propose, gate and apply are built; the *deliberate* stage and Dossier ingest are still intent. |
| **[RLM security posture](rlm-security-posture.md)** | The rules self-modification and persistent execution sessions must obey, and which of them the runtime actually enforces. |

## Working on it

| | |
| --- | --- |
| **[AGENTS.md](../AGENTS.md)** | Read before contributing. Also what an agent working on this repository follows — including the minimal-change principle and the definition of done. |
| **[CONTRIBUTING.md](../CONTRIBUTING.md)** | Issue coordination and pull request guidance. |
| **[DEV_SETUP.md](../DEV_SETUP.md)** | Local development, the toolchain split, and repository layout. |
| **[CI](ci.md)** | The gate that runs, what it covers, and what it deliberately does not. |
| **[Long-context baseline](../evals/longcontext/README.md)** | What an oversized tool result costs the parent's context window, and the committed scorecard CI diffs against. |
| **[SECURITY.md](../SECURITY.md)** | Reporting a vulnerability, and what is in scope. |

## A note on the two halves

Most of this repository is vendored from
[Atomic](https://github.com/bastani-inc/atomic), itself a fork of pi. The agent
loop, providers, tools, MCP, subagents, workflows, and the TUI all come from
there and behave as they do upstream.

What Orphus authors is `packages/roundtable/` — rooms, the budgeted digest, the
broker, the role launcher, the memory adapter — and `packages/fleet/` — the
blueprint loader, `/fleet` and `/fleetsetup`, and the orchestration skills —
plus their tests, this documentation, and `.github/workflows/ci.yml`.

The practical consequence: a question about *rooms, digests, roles, memory, or
fleets* belongs here. A question about the harness underneath is usually
answered upstream, and a bug there is worth reporting to both.

The `archive/upstream/` directory holds Atomic's inherited working notes — 383
files written for a different project. Nothing reads them, and nothing new
should be added there.
