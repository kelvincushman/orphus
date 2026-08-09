import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { createFleetTool } from "../../packages/fleet/fleet-tool.ts";

let root: string;
let cwd: string;
let agentDir: string;

const VALID = `
name: coding-team
description: A team that codes.
teams:
  implementation:
    mode: dispatch
    members:
      - agent: worker
`;

function tool() {
	return createFleetTool({ cwd: () => cwd, env: { ORPHUS_CODING_AGENT_DIR: agentDir } });
}

async function run(params: { action: "list" | "get" | "validate"; name?: string; path?: string }) {
	return await tool().execute("call-1", params, new AbortController().signal, undefined, {
		model: { provider: "anthropic", id: "claude-opus" },
		modelRegistry: {
			getAll: () => [
				{ provider: "anthropic", id: "claude-opus" },
				{ provider: "openai-codex", id: "gpt-fast" },
			],
			getAvailable: () => [{ provider: "anthropic", id: "claude-opus" }],
		},
	} as never);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orphus-fleet-tool-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".orphus", "fleets"), { recursive: true });
	mkdirSync(join(agentDir, "fleets"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("fleet tool", () => {
	test("list shows discovered fleets with scope, and says so when none exist", async () => {
		const empty = await run({ action: "list" });
		assert.equal(empty.isError, false);
		assert.match(empty.content[0]!.text, /no fleet blueprints/iu);

		writeFileSync(join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"), VALID);
		writeFileSync(join(agentDir, "fleets", "media-team.fleet.yaml"), VALID.replace("coding-team", "media-team"));
		const listed = await run({ action: "list" });
		assert.match(listed.content[0]!.text, /coding-team.*project/su);
		assert.match(listed.content[0]!.text, /media-team.*user/su);
	});

	test("get summarizes a blueprint's teams and members", async () => {
		writeFileSync(join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"), VALID);
		const result = await run({ action: "get", name: "coding-team" });
		assert.equal(result.isError, false);
		assert.match(result.content[0]!.text, /implementation.*dispatch/su);
		assert.match(result.content[0]!.text, /worker/u);
	});

	test("validate passes a good blueprint and reports warnings", async () => {
		writeFileSync(
			join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"),
			VALID.replace("mode: dispatch", "mode: dispatch\n    concurrency: 9"),
		);
		const result = await run({ action: "validate", name: "coding-team" });
		assert.equal(result.isError, false);
		assert.match(result.content[0]!.text, /valid/iu);
		assert.match(result.content[0]!.text, /concurrency/u);
	});

	test("validate reports loader errors verbatim without throwing", async () => {
		writeFileSync(join(cwd, ".orphus", "fleets", "bad.fleet.yaml"), "name: bad\nteams: {}\n");
		const result = await run({ action: "validate", name: "bad" });
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /description/u);
	});

	test("validate rejects a member model that would silently fall back at runtime", async () => {
		writeFileSync(
			join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"),
			VALID.replace("- agent: worker", "- agent: worker\n        model: openai-codex/gpt-fast"),
		);
		const result = await run({ action: "validate", name: "coding-team" });
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /members\[0\]\.model.*\/login openai-codex/su);
	});

	test("validate applies the same registry preflight to the orchestrator model", async () => {
		writeFileSync(
			join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"),
			VALID.replace(
				"description: A team that codes.",
				"description: A team that codes.\norchestrator: { model: unknown/nope }",
			),
		);
		const result = await run({ action: "validate", name: "coding-team" });
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /orchestrator\.model.*not in the model registry/su);
	});

	test("validate accepts an explicit path outside the discovery roots", async () => {
		const loose = join(root, "anywhere.fleet.yaml");
		writeFileSync(loose, VALID);
		const result = await run({ action: "validate", path: loose });
		assert.equal(result.isError, false);
	});

	test("unknown names error and list what exists", async () => {
		writeFileSync(join(cwd, ".orphus", "fleets", "coding-team.fleet.yaml"), VALID);
		const result = await run({ action: "get", name: "ghost" });
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /coding-team/u);
	});
});
