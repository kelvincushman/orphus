import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { EvidenceCandidate } from "../../packages/subagents/src/refine/evidence-bundle.ts";
import { runCollectStage, runGateStage, runProposeStage } from "../../packages/subagents/src/refine/flow.ts";
import {
	handleRefineCommand,
	REFINE_USAGE,
	type RefineCommandDeps,
	retrospectiveBrief,
} from "../../packages/subagents/src/refine/refine-command.ts";

const RUN_ID = "run1";
const NOW = "2026-08-15T00:00:00.000Z";

let base: string;
let sessionFile: string;
let repoRoot: string;
let deps: RefineCommandDeps;

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "refine-cmd-"));
	sessionFile = path.join(base, "session", "session.jsonl");
	repoRoot = path.join(base, "repo");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.mkdirSync(path.join(repoRoot, "skills"), { recursive: true });
	fs.writeFileSync(sessionFile, "{}\n");
	fs.writeFileSync(path.join(repoRoot, "skills", "a.md"), "original\n");
	deps = { sessionFile, repoRoot, now: () => NOW, writeContent: () => "applied\n" };
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

function candidates(): EvidenceCandidate[] {
	return [{ kind: "session", label: "session transcript", path: sessionFile }];
}

function seedGatedRun(source = "session transcript") {
	runCollectStage({ runId: RUN_ID, sessionFile, candidates: candidates(), createdAt: NOW });
	runProposeStage({
		runId: RUN_ID,
		sessionFile,
		structuredOutput: {
			proposals: [
				{
					targetPath: "skills/a.md",
					diff: "--- a\n+++ b\n+improved\n",
					justification: "the same repair twice",
					evidence: [{ source, locator: "line 4" }],
				},
			],
		},
	});
	return runGateStage({ runId: RUN_ID, sessionFile });
}

test("a bare command prints usage", () => {
	assert.equal(handleRefineCommand("", deps), REFINE_USAGE);
	assert.equal(handleRefineCommand("   ", deps), REFINE_USAGE);
	assert.equal(handleRefineCommand("apply", deps), REFINE_USAGE);
});

test("a hostile run id is refused before it reaches a path", () => {
	for (const bad of ["../../etc", "a/b", "rollback ../../etc"]) {
		assert.match(handleRefineCommand(bad, deps), /runId/);
	}
});

test("apply changes the tree and rollback puts it back", () => {
	seedGatedRun();
	const target = path.join(repoRoot, "skills", "a.md");

	const applied = handleRefineCommand(`apply ${RUN_ID}`, deps);
	assert.match(applied, /modified skills\/a\.md/);
	assert.equal(fs.readFileSync(target, "utf8"), "applied\n");

	const rolled = handleRefineCommand(`rollback ${RUN_ID}`, deps);
	assert.match(rolled, /Restored 1 file/);
	assert.equal(fs.readFileSync(target, "utf8"), "original\n");
});

test("apply does nothing for a proposal the gate refused", () => {
	seedGatedRun("not-a-real-source");
	const target = path.join(repoRoot, "skills", "a.md");

	const applied = handleRefineCommand(`apply ${RUN_ID}`, deps);

	assert.match(applied, /Applied nothing/);
	assert.equal(fs.readFileSync(target, "utf8"), "original\n");
});

test("a bare runId reports status without applying anything", () => {
	seedGatedRun();
	const target = path.join(repoRoot, "skills", "a.md");

	const status = handleRefineCommand(RUN_ID, deps);

	assert.match(status, /Nothing has been applied/);
	assert.match(status, /\/refine apply run1/);
	assert.equal(fs.readFileSync(target, "utf8"), "original\n");
});

test("a run with no gate results says so instead of throwing", () => {
	assert.match(handleRefineCommand("never-refined", deps), /No gate results yet/);
});

test("rollback on a run that was never applied says so", () => {
	// Tightened: the earlier matcher also accepted a raw ENOENT, which is exactly
	// what this was meant to rule out.
	const answer = handleRefineCommand(`rollback ${RUN_ID}`, deps);
	assert.match(answer, /Nothing to roll back for run1 — no apply has been recorded\./);
	assert.doesNotMatch(answer, /ENOENT/);
});

test("the retrospective brief hands over a path, not a transcript", () => {
	// The bundle exists so evidence costs the reader what they choose to open.
	// Inlining it into the brief would spend that budget on their behalf.
	const brief = retrospectiveBrief(RUN_ID, "/sessions/abc/refine/run1/evidence/manifest.json");

	assert.match(brief, /\/sessions\/abc\/refine\/run1\/evidence\/manifest\.json/);
	assert.match(brief, /A source reported missing is unrecoverable/);
	assert.match(brief, /Returning zero proposals is a valid outcome/);
	assert.ok(brief.length < 1000, "the brief must stay small — it is a pointer, not a payload");
});
