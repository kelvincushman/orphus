import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseFleetBlueprint } from "../../packages/fleet/blueprint/manifest.ts";
import { memberNames, renderFleetRunPrompt } from "../../packages/fleet/blueprint/render.ts";

const BLUEPRINT = parseFleetBlueprint(
	`
name: coding-team
description: d
defaults:
  concurrency: 3
  budgets: { digest: 1500, perMessage: 400 }
teams:
  design:
    mode: deliberate
    topic: Architecture
    rounds: 2
    skills: [thinking]
    members:
      - agent: architect
      - agent: worker
        skills: [tdd]
  implementation:
    mode: dispatch
    group: true
    members:
      - agent: worker
        count: 2
        skills: [coding-standards]
      - agent: debugger
  review:
    mode: deliberate-then-dispatch
    members:
      - agent: code-simplifier
pipeline: [design, implementation, review]
`,
	"/tmp/coding-team.fleet.yaml",
);

describe("fleet render", () => {
	test("memberNames are unique for count > 1 and stable otherwise", () => {
		const impl = BLUEPRINT.teams[1]!;
		assert.deepEqual(memberNames(impl), ["worker-1", "worker-2", "debugger"]);
		const design = BLUEPRINT.teams[0]!;
		assert.deepEqual(memberNames(design), ["architect", "worker"]);
	});

	test("memberNames avoid collisions with declared agent names", () => {
		const collision = parseFleetBlueprint(
			`
name: collision
description: d
teams:
  t:
    mode: deliberate
    members:
      - agent: worker
        count: 2
      - agent: worker-1
`,
			"/tmp/collision.fleet.yaml",
		).teams[0]!;
		assert.deepEqual(memberNames(collision), ["worker-2", "worker-3", "worker-1"]);
		assert.equal(new Set(memberNames(collision)).size, 3);
	});

	test("the run prompt carries task, rooms, budgets, and the skill-load instruction", () => {
		const prompt = renderFleetRunPrompt(BLUEPRINT, "add a --version flag");
		assert.match(prompt, /add a --version flag/u);
		assert.match(prompt, /fleet-orchestration/u);
		assert.match(prompt, /fleet-coding-team-design/u);
		assert.match(prompt, /budget 1500/u);
		assert.match(prompt, /2 rounds?|rounds: 2/iu);
	});

	test("dispatch teams get a literal subagent recipe with names, skill unions, group, and concurrency", () => {
		const prompt = renderFleetRunPrompt(BLUEPRINT, "task");
		assert.match(prompt, /"name": "worker-1"/u);
		assert.match(prompt, /"name": "worker-2"/u);
		assert.match(prompt, /"skill": \[\s*"coding-standards"\s*\]/u);
		assert.match(prompt, /"group": true/u);
		assert.match(prompt, /"concurrency": 3/u);
	});

	test("deliberate teams get the member room-template with FINAL discipline and a parent digest recipe", () => {
		const prompt = renderFleetRunPrompt(BLUEPRINT, "task");
		assert.match(prompt, /join.*fleet-coding-team-design/iu);
		assert.match(prompt, /FINAL:/u);
		assert.match(prompt, /roundtable.*digest.*fleet-coding-team-design/su);
		// team ∪ member skills for the deliberate member
		assert.match(prompt, /"skill": \[\s*"thinking",\s*"tdd"\s*\]/u);
	});

	test("repo agent config files are referenced, never inlined", () => {
		const prompt = renderFleetRunPrompt(BLUEPRINT, "task", {
			files: ["docs/agents/issue-tracker.md", "docs/agents/domain.md"],
		});
		assert.match(prompt, /Repo agent config: docs\/agents\/issue-tracker\.md, docs\/agents\/domain\.md/u);
		assert.match(prompt, /Read the relevant file before tracker or domain operations/u);
		// Absent or empty config leaves the prompt untouched — blueprints are
		// identical everywhere; the repo adapts them only when it says so.
		assert.doesNotMatch(renderFleetRunPrompt(BLUEPRINT, "task"), /Repo agent config/u);
		assert.doesNotMatch(renderFleetRunPrompt(BLUEPRINT, "task", { files: [] }), /Repo agent config/u);
	});

	test("deliberate members are told the join is first and the room is the deliverable", () => {
		// A member's own system prompt can beat a polite protocol: the first live
		// panel had a member research diligently and never join. The template must
		// leave no room for that reading.
		const prompt = renderFleetRunPrompt(BLUEPRINT, "task");
		assert.match(prompt, /FIRST tool call MUST be roundtable/u);
		assert.match(prompt, /before any reading or research/u);
		assert.match(prompt, /room is your deliverable/u);
		assert.match(prompt, /Return just your FINAL line/u);
	});

	test("deliberate-then-dispatch teams carry both phases in order", () => {
		const prompt = renderFleetRunPrompt(BLUEPRINT, "task");
		const section = prompt.slice(prompt.indexOf("review"));
		assert.match(section, /deliberate/iu);
		assert.match(section, /dispatch/iu);
	});

	test("member tools grants reach the recipe so deliberate members can join rooms", () => {
		const granted = parseFleetBlueprint(
			`
name: x
description: d
teams:
  t:
    mode: deliberate
    members:
      - agent: codebase-analyzer
        tools: [read, search, roundtable]
`,
			"/tmp/x.fleet.yaml",
		);
		assert.match(renderFleetRunPrompt(granted, "task"), /"tools": \[\s*"read",\s*"search",\s*"roundtable"\s*\]/u);
	});

	test("a declared gate renders reviewers-then-verdict into the run prompt", () => {
		const gated = parseFleetBlueprint(
			`
name: x
description: d
gate:
  reviewers: [coderabbit, greptile]
  model: openai-codex/gpt-5.6-sol
teams:
  t:
    mode: dispatch
    members:
      - agent: worker
`,
			"/tmp/x.fleet.yaml",
		);
		const prompt = renderFleetRunPrompt(gated, "task");
		assert.match(prompt, /Final gate/u);
		assert.match(prompt, /coderabbit and greptile/u);
		assert.match(prompt, /gpt-5\.6-sol/u);
		assert.doesNotMatch(renderFleetRunPrompt(BLUEPRINT, "task"), /Final gate/u);
	});

	test("a pinned member model reaches its recipe entry", () => {
		const pinned = parseFleetBlueprint(
			`
name: x
description: d
teams:
  t:
    mode: dispatch
    members:
      - agent: worker
        model: openai-codex/gpt-fast
`,
			"/tmp/x.fleet.yaml",
		);
		assert.match(renderFleetRunPrompt(pinned, "task"), /"model": "openai-codex\/gpt-fast"/u);
	});
});
