import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { discoverFleets, fleetRoots } from "../../packages/fleet/blueprint/discovery.ts";

let root: string;
let cwd: string;
let agentDir: string;

function put(dir: string, file: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, file),
		"name: placeholder\ndescription: d\nteams: { t: { mode: dispatch, members: [{ agent: worker }] } }\n",
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orphus-fleet-discovery-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("fleet discovery", () => {
	test("fleetRoots honors the agent-dir env override and the config-dir lineage", () => {
		const roots = fleetRoots(cwd, { ORPHUS_CODING_AGENT_DIR: agentDir });
		assert.deepEqual(roots.projectDirs, [
			join(cwd, ".orphus", "fleets"),
			join(cwd, ".atomic", "fleets"),
			join(cwd, ".pi", "fleets"),
		]);
		assert.equal(roots.userDir, join(agentDir, "fleets"));
	});

	test("finds project and user fleets; project shadows user by name", () => {
		put(join(cwd, ".orphus", "fleets"), "coding-team.fleet.yaml");
		put(join(agentDir, "fleets"), "coding-team.fleet.yaml");
		put(join(agentDir, "fleets"), "media-team.fleet.yaml");

		const found = discoverFleets({
			...fleetRoots(cwd, { ORPHUS_CODING_AGENT_DIR: agentDir }),
			bundledDir: join(root, "empty-bundled"),
		});
		assert.deepEqual(
			found.map((fleet) => [fleet.name, fleet.scope, fleet.shadowed]),
			[
				["coding-team", "project", false],
				["coding-team", "user", true],
				["media-team", "user", false],
			],
		);
	});

	test("legacy .atomic project dir is found when .orphus has no entry", () => {
		put(join(cwd, ".atomic", "fleets"), "legacy.fleet.yaml");
		const found = discoverFleets({
			...fleetRoots(cwd, { ORPHUS_CODING_AGENT_DIR: agentDir }),
			bundledDir: join(root, "empty-bundled"),
		});
		assert.deepEqual(
			found.map((fleet) => fleet.name),
			["legacy"],
		);
		assert.equal(found[0]?.scope, "project");
	});

	test("bundled examples are discovered and shadowed by user and project scopes", () => {
		const bundledDir = join(root, "bundled");
		put(bundledDir, "coding-team.fleet.yaml");
		put(bundledDir, "media-team.fleet.yaml");
		put(join(agentDir, "fleets"), "media-team.fleet.yaml");

		const roots = { ...fleetRoots(cwd, { ORPHUS_CODING_AGENT_DIR: agentDir }), bundledDir };
		const found = discoverFleets(roots);
		assert.deepEqual(
			found.map((fleet) => [fleet.name, fleet.scope, fleet.shadowed]),
			[
				["coding-team", "bundled", false],
				["media-team", "user", false],
				["media-team", "bundled", true],
			],
		);
	});

	test("default roots point bundledDir at the package examples", () => {
		const roots = fleetRoots(cwd, { ORPHUS_CODING_AGENT_DIR: agentDir });
		assert.match(roots.bundledDir, /packages[/\\]fleet[/\\]examples$|fleet[/\\]examples$/u);
	});

	test("ignores files without the .fleet.yaml suffix and missing directories", () => {
		mkdirSync(join(cwd, ".orphus", "fleets"), { recursive: true });
		writeFileSync(join(cwd, ".orphus", "fleets", "README.md"), "not a fleet\n");
		writeFileSync(join(cwd, ".orphus", "fleets", "x.yaml"), "not a fleet\n");
		const found = discoverFleets({
			...fleetRoots(cwd, { ORPHUS_CODING_AGENT_DIR: agentDir }),
			bundledDir: join(root, "empty-bundled"),
		});
		assert.deepEqual(found, []);
	});
});
