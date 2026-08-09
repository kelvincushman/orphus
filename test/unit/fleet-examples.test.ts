import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { loadFleetBlueprint } from "../../packages/fleet/blueprint/manifest.ts";
import { moduleDir } from "../helpers/runtime.ts";

const EXAMPLES_DIR = join(moduleDir(import.meta.url), "../../packages/fleet/examples");

/**
 * Shipped artifacts can never rot: every bundled blueprint must parse clean.
 * Warnings are allowed (they are advisory by design); errors are not.
 */
describe("bundled fleet examples", () => {
	const files = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith(".fleet.yaml"));

	test("the documented example set ships", () => {
		assert.deepEqual(files.sort(), [
			"blog-pipeline.fleet.yaml",
			"coding-team.fleet.yaml",
			"design-team.fleet.yaml",
			"docs-release-team.fleet.yaml",
			"media-team.fleet.yaml",
			"research-team.fleet.yaml",
		]);
	});

	for (const file of files) {
		test(`${file} parses without errors`, () => {
			const blueprint = loadFleetBlueprint(join(EXAMPLES_DIR, file));
			assert.equal(`${blueprint.name}.fleet.yaml`, file, "blueprint name must match its filename");
			assert.ok(blueprint.teams.length >= 1);
		});
	}
});
