import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { loadFleetBlueprint, parseFleetBlueprint } from "../../packages/fleet/blueprint/manifest.ts";
import { FleetBlueprintError } from "../../packages/fleet/blueprint/types.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orphus-fleet-"));
	mkdirSync(join(dir, "briefs"));
	writeFileSync(join(dir, "briefs", "architect.md"), "Argue for boring designs.\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function blueprintPath(): string {
	return join(dir, "coding-team.fleet.yaml");
}

const MINIMAL = `
name: coding-team
description: A minimal fleet.
teams:
  implementation:
    mode: dispatch
    members:
      - agent: worker
`;

const FULL = `
name: coding-team
description: Design deliberation, bounded dispatch.
version: 1
orchestrator:
  model: anthropic/claude-opus
defaults:
  concurrency: 3
  budgets:
    digest: 1500
    perMessage: 400
teams:
  design:
    mode: deliberate
    room: fleet-coding-design
    topic: Architecture decisions
    rounds: 2
    members:
      - agent: codebase-analyzer
      - agent: architect
        briefPath: briefs/architect.md
      - agent: worker
        brief: |
          Argue for the smallest change that works.
  implementation:
    mode: dispatch
    skills: [tdd]
    group: true
    members:
      - agent: worker
        count: 2
        skills: [coding-standards]
      - agent: debugger
        model: openai-codex/gpt-fast
pipeline: [design, implementation]
`;

describe("fleet blueprint parsing", () => {
	test("parses the documented full shape", () => {
		const blueprint = parseFleetBlueprint(FULL, blueprintPath());
		assert.equal(blueprint.name, "coding-team");
		assert.equal(blueprint.version, 1);
		assert.equal(blueprint.orchestratorModel, "anthropic/claude-opus");
		assert.deepEqual(blueprint.defaults, { concurrency: 3, budgets: { digest: 1500, perMessage: 400 } });
		assert.deepEqual(
			blueprint.teams.map((team) => team.name),
			["design", "implementation"],
		);

		const design = blueprint.teams[0]!;
		assert.equal(design.mode, "deliberate");
		assert.equal(design.room, "fleet-coding-design");
		assert.equal(design.topic, "Architecture decisions");
		assert.equal(design.rounds, 2);
		assert.equal(design.members.length, 3);
		assert.equal(design.members[1]?.briefPath, join(dir, "briefs", "architect.md"));
		assert.match(design.members[2]?.brief ?? "", /smallest change/u);

		const impl = blueprint.teams[1]!;
		assert.deepEqual(impl.skills, ["tdd"]);
		assert.equal(impl.group, true);
		assert.equal(impl.members[0]?.count, 2);
		assert.deepEqual(impl.members[0]?.skills, ["coding-standards"]);
		assert.equal(impl.members[1]?.model, "openai-codex/gpt-fast");
		assert.deepEqual(blueprint.pipeline, ["design", "implementation"]);
	});

	test("applies defaults: version 1, room fleet-<fleet>-<team>, concurrency 4, budgets, rounds 2", () => {
		const blueprint = parseFleetBlueprint(MINIMAL, blueprintPath());
		assert.equal(blueprint.version, 1);
		assert.equal(blueprint.orchestratorModel, undefined);
		assert.deepEqual(blueprint.defaults, { concurrency: 4, budgets: { digest: 2000, perMessage: 600 } });
		assert.equal(blueprint.teams[0]?.room, "fleet-coding-team-implementation");
		assert.equal(blueprint.teams[0]?.rounds, 2);
		assert.deepEqual(blueprint.pipeline, ["implementation"]);
	});

	test("rejects unknown keys at every level, naming file and key path", () => {
		for (const [yaml, keyPath] of [
			[`${MINIMAL}\ncolour: blue\n`, "colour"],
			[MINIMAL.replace("mode: dispatch", "mode: dispatch\n    speed: fast"), "teams.implementation.speed"],
			[
				MINIMAL.replace("- agent: worker", "- agent: worker\n        hat: red"),
				"teams.implementation.members[0].hat",
			],
		] as const) {
			assert.throws(
				() => parseFleetBlueprint(yaml, blueprintPath()),
				(error: unknown) => {
					assert.ok(error instanceof FleetBlueprintError);
					assert.match(error.message, new RegExp(keyPath.replace(/[[\]]/gu, "\\$&"), "u"));
					assert.match(error.message, /coding-team\.fleet\.yaml/u);
					return true;
				},
			);
		}
	});

	test("rejects a bad mode with the allowed set in the message", () => {
		assert.throws(
			() => parseFleetBlueprint(MINIMAL.replace("mode: dispatch", "mode: sprint"), blueprintPath()),
			/dispatch, deliberate, deliberate-then-dispatch/u,
		);
	});

	test("rejects names failing the broker-safe pattern", () => {
		for (const yaml of [
			MINIMAL.replace("name: coding-team", "name: 'coding team'"),
			MINIMAL.replace("implementation:", "'impl team':"),
			MINIMAL.replace("mode: dispatch", "mode: dispatch\n    room: 'has space'"),
		]) {
			assert.throws(() => parseFleetBlueprint(yaml, blueprintPath()), FleetBlueprintError);
		}
	});

	test("allows dots in member agent references (namespaced runtime names)", () => {
		const blueprint = parseFleetBlueprint(
			MINIMAL.replace("- agent: worker", "- agent: code-analysis.custom-agent"),
			blueprintPath(),
		);
		assert.equal(blueprint.teams[0]?.members[0]?.agent, "code-analysis.custom-agent");
	});

	test("rejects brief and briefPath together, and a missing or unreadable briefPath", () => {
		assert.throws(
			() =>
				parseFleetBlueprint(
					MINIMAL.replace(
						"- agent: worker",
						"- agent: worker\n        brief: inline\n        briefPath: briefs/architect.md",
					),
					blueprintPath(),
				),
			/brief.*briefPath|briefPath.*brief/u,
		);
		assert.throws(
			() =>
				parseFleetBlueprint(
					MINIMAL.replace("- agent: worker", "- agent: worker\n        briefPath: briefs/missing.md"),
					blueprintPath(),
				),
			/file not found/u,
		);
		// A directory is not a brief: --append-system-prompt semantics made this a
		// real bug class in the roles manifest, and the same check applies here.
		assert.throws(
			() =>
				parseFleetBlueprint(
					MINIMAL.replace("- agent: worker", "- agent: worker\n        briefPath: briefs"),
					blueprintPath(),
				),
			/not a regular file/u,
		);
	});

	test("load rejects a directory with a blueprint error instead of leaking a filesystem exception", () => {
		assert.throws(() => loadFleetBlueprint(dir), /not a regular file/u);
	});

	test("rejects an empty team and an empty fleet", () => {
		assert.throws(
			() => parseFleetBlueprint("name: x\ndescription: d\nteams: {}\n", blueprintPath()),
			/at least one team/u,
		);
		assert.throws(
			() => parseFleetBlueprint(MINIMAL.replace(/members:[\s\S]*$/u, "members: []\n"), blueprintPath()),
			/at least one member/u,
		);
	});

	test("caps expanded members per team at the parallel-task limit", () => {
		assert.throws(
			() =>
				parseFleetBlueprint(
					MINIMAL.replace("- agent: worker", "- agent: worker\n        count: 51"),
					blueprintPath(),
				),
			/50/u,
		);
	});

	test("rejects a version other than 1 and a pipeline naming an unknown team", () => {
		assert.throws(() => parseFleetBlueprint(`${MINIMAL}version: 2\n`, blueprintPath()), /version/u);
		assert.throws(() => parseFleetBlueprint(`${MINIMAL}pipeline: [ghost]\n`, blueprintPath()), /ghost/u);
	});

	test("requires an explicit pipeline to name every team exactly once", () => {
		const twoTeams = MINIMAL.replace(
			"teams:\n",
			"teams:\n  design:\n    mode: deliberate\n    members:\n      - agent: architect\n",
		);
		assert.throws(
			() => parseFleetBlueprint(`${twoTeams}pipeline: []\n`, blueprintPath()),
			/missing: design, implementation/u,
		);
		assert.throws(
			() => parseFleetBlueprint(`${twoTeams}pipeline: [design, design, implementation]\n`, blueprintPath()),
			/appears more than once/u,
		);
		assert.throws(
			() => parseFleetBlueprint(`${twoTeams}pipeline: [implementation]\n`, blueprintPath()),
			/missing: design/u,
		);
	});

	test("applies the documented default concurrency warning and hard ceiling", () => {
		const warned = parseFleetBlueprint(
			MINIMAL.replace(
				"description: A minimal fleet.",
				"description: A minimal fleet.\ndefaults: { concurrency: 9 }",
			),
			blueprintPath(),
		);
		assert.match(warned.warnings.join("\n"), /defaults\.concurrency 9/u);
		assert.throws(
			() =>
				parseFleetBlueprint(
					MINIMAL.replace(
						"description: A minimal fleet.",
						"description: A minimal fleet.\ndefaults: { concurrency: 51 }",
					),
					blueprintPath(),
				),
			/parallel-task ceiling of 50/u,
		);
	});

	test("warns when an explicit room collides with another team's default room", () => {
		const blueprint = parseFleetBlueprint(
			MINIMAL.replace(
				"teams:\n",
				"teams:\n  design:\n    mode: deliberate\n    room: fleet-coding-team-implementation\n    members:\n      - agent: architect\n",
			),
			blueprintPath(),
		);
		assert.match(blueprint.warnings.join("\n"), /design and implementation share room/u);
	});

	test("warns without failing on concurrency above the default", () => {
		const blueprint = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: dispatch\n    concurrency: 9"),
			blueprintPath(),
		);
		assert.equal(blueprint.teams[0]?.concurrency, 9);
		assert.ok(blueprint.warnings.some((warning) => warning.includes("concurrency")));
	});

	test("warns without failing when two teams share an explicit room", () => {
		const yaml = `
name: x
description: d
teams:
  one:
    mode: deliberate
    room: shared
    members: [{ agent: worker }]
  two:
    mode: deliberate
    room: shared
    members: [{ agent: debugger }]
`;
		const blueprint = parseFleetBlueprint(yaml, blueprintPath());
		assert.ok(blueprint.warnings.some((warning) => warning.includes("shared")));
	});

	test("warns that rounds has no effect on a dispatch team", () => {
		const blueprint = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: dispatch\n    rounds: 3"),
			blueprintPath(),
		);
		assert.ok(blueprint.warnings.some((warning) => warning.includes("rounds")));
	});

	test("blocking is parsed, optional, and rejected when it is not a boolean", () => {
		const withBlocking = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: deliberate\n    blocking: true"),
			blueprintPath(),
		);
		assert.equal(withBlocking.teams[0]?.blocking, true);

		// Absent means asynchronous; the field stays undefined rather than being
		// defaulted into every parsed team, so "not stated" reads as not stated.
		const withoutBlocking = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: deliberate"),
			blueprintPath(),
		);
		assert.equal(withoutBlocking.teams[0]?.blocking, undefined);

		assert.throws(() =>
			parseFleetBlueprint(
				MINIMAL.replace("mode: dispatch", "mode: deliberate\n    blocking: yes-please"),
				blueprintPath(),
			),
		);
	});

	test("deadlineMs parses, and warns when paired with blocking", () => {
		const withDeadline = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: deliberate\n    deadlineMs: 900000"),
			blueprintPath(),
		);
		assert.equal(withDeadline.teams[0]?.deadlineMs, 900000);

		const contradictory = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: deliberate\n    blocking: true\n    deadlineMs: 900000"),
			blueprintPath(),
		);
		assert.ok(contradictory.warnings.some((warning) => warning.includes("deadlineMs")));
	});

	test("warns that blocking has no effect on a dispatch team", () => {
		const blueprint = parseFleetBlueprint(
			MINIMAL.replace("mode: dispatch", "mode: dispatch\n    blocking: true"),
			blueprintPath(),
		);
		assert.ok(blueprint.warnings.some((warning) => warning.includes("blocking")));
	});

	test("parses member tools as an explicit allowlist grant", () => {
		const withTools = parseFleetBlueprint(
			MINIMAL.replace("- agent: worker", "- agent: worker\n        tools: [read, roundtable]"),
			blueprintPath(),
		);
		assert.deepEqual(withTools.teams[0]?.members[0]?.tools, ["read", "roundtable"]);
		assert.equal(parseFleetBlueprint(MINIMAL, blueprintPath()).teams[0]?.members[0]?.tools, undefined);
	});

	test("parses the final-gate block and defaults to none", () => {
		const gated = parseFleetBlueprint(
			`${MINIMAL}gate:\n  reviewers: [coderabbit]\n  model: openai-codex/gpt-5.6-sol\n`,
			blueprintPath(),
		);
		assert.deepEqual(gated.gate, { reviewers: ["coderabbit"], model: "openai-codex/gpt-5.6-sol" });
		assert.equal(parseFleetBlueprint(MINIMAL, blueprintPath()).gate, undefined);
	});

	test("rejects unknown gate keys and empty gate values", () => {
		assert.throws(() => parseFleetBlueprint(`${MINIMAL}gate:\n  robot: yes\n`, blueprintPath()), /gate\.robot/u);
		assert.throws(
			() => parseFleetBlueprint(`${MINIMAL}gate:\n  reviewers: []\n`, blueprintPath()),
			/at least one reviewer|reviewers/u,
		);
	});

	test("loadFleetBlueprint reads from disk and names a missing file", () => {
		writeFileSync(blueprintPath(), MINIMAL);
		const blueprint = loadFleetBlueprint(blueprintPath());
		assert.equal(blueprint.name, "coding-team");
		assert.throws(() => loadFleetBlueprint(join(dir, "nope.fleet.yaml")), /not found/u);
	});
});
