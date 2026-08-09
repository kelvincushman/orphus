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

	test("deliberate-then-dispatch teams carry both phases in order", () => {
		const prompt = renderFleetRunPrompt(BLUEPRINT, "task");
		const section = prompt.slice(prompt.indexOf("review"));
		assert.match(section, /deliberate/iu);
		assert.match(section, /dispatch/iu);
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
