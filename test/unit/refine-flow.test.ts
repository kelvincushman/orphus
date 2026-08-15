import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { applyGatedProposals, rollbackApply } from "../../packages/subagents/src/refine/applier.ts";
import type { EvidenceCandidate } from "../../packages/subagents/src/refine/evidence-bundle.ts";
import {
	approvalPrompt,
	readEvidenceBundle,
	readGateResults,
	readProposals,
	refinePaths,
	runCollectStage,
	runGateStage,
	runProposeStage,
} from "../../packages/subagents/src/refine/flow.ts";

const CREATED_AT = "2026-08-15T00:00:00.000Z";
const RUN_ID = "run1";

let base: string;
let sessionFile: string;
let repoRoot: string;

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "refine-flow-"));
	sessionFile = path.join(base, "session", "session.jsonl");
	repoRoot = path.join(base, "repo");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.mkdirSync(path.join(repoRoot, "skills"), { recursive: true });
	fs.writeFileSync(sessionFile, "{}\n");
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

function candidates(): EvidenceCandidate[] {
	return [
		{ kind: "session", label: "session transcript", path: sessionFile },
		{ kind: "room-transcript", label: "#design", path: path.join(base, "gone.md"), absenceHint: "broker exited" },
	];
}

function collect() {
	return runCollectStage({ runId: RUN_ID, sessionFile, candidates: candidates(), createdAt: CREATED_AT });
}

function propose(evidenceSource = "session transcript") {
	return runProposeStage({
		runId: RUN_ID,
		sessionFile,
		structuredOutput: {
			proposals: [
				{
					targetPath: "skills/a.md",
					diff: "--- a\n+++ b\n+improved\n",
					justification: "the same repair happened twice",
					evidence: [{ source: evidenceSource, locator: "line 4" }],
				},
			],
		},
	});
}

test("the stages hand off through disk, so each can run separately", () => {
	// Not an implementation detail: it is what lets a human read the proposals
	// between gate and apply, and what makes an interrupted refine resumable.
	collect();
	propose();
	runGateStage({ runId: RUN_ID, sessionFile });

	const paths = refinePaths(sessionFile, RUN_ID);
	assert.equal(fs.existsSync(path.join(paths.evidenceDir, "manifest.json")), true);
	assert.equal(fs.existsSync(path.join(paths.proposalsDir, "000.json")), true);
	assert.equal(fs.existsSync(paths.gateResultsPath), true);

	assert.equal(readEvidenceBundle(sessionFile, RUN_ID).runId, RUN_ID);
	assert.equal(readProposals(sessionFile, RUN_ID).length, 1);
	assert.equal(readGateResults(sessionFile, RUN_ID).length, 1);
});

test("a full cycle applies a gated proposal and rolls it back byte-identically", () => {
	// The phase's acceptance criterion, end to end.
	const target = path.join(repoRoot, "skills", "a.md");
	const original = "original skill\n";
	fs.writeFileSync(target, original);

	collect();
	propose();
	const { gated } = runGateStage({ runId: RUN_ID, sessionFile });
	assert.equal(gated[0]?.verdict.passed, true);

	const paths = refinePaths(sessionFile, RUN_ID);
	applyGatedProposals({
		runId: RUN_ID,
		gated,
		repoRoot,
		snapshotsDir: paths.snapshotsDir,
		appliedAt: CREATED_AT,
		writeContent: () => "improved skill\n",
	});
	assert.equal(fs.readFileSync(target, "utf8"), "improved skill\n");

	rollbackApply({ repoRoot, snapshotsDir: paths.snapshotsDir });
	assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("a planted bad proposal is rejected by the gate", () => {
	// The phase's other acceptance criterion: evidence that does not support the
	// edit must not pass. Here the citation names a source the bundle reported
	// missing — the shape that looks most like a real citation.
	collect();
	propose("#design");

	const { gated, summary } = runGateStage({ runId: RUN_ID, sessionFile });

	assert.equal(gated[0]?.verdict.passed, false);
	assert.deepEqual(
		gated[0]?.verdict.objections.map((objection) => objection.rule),
		["citation-names-missing-evidence"],
	);
	assert.match(summary, /0\/1 proposal\(s\) eligible/);
});

test("nothing is applied without a human typing apply", () => {
	// Stop-for-approval is structural: there is no configuration that makes the
	// loop autonomous, because applying is a separate command.
	const target = path.join(repoRoot, "skills", "a.md");
	fs.writeFileSync(target, "untouched\n");

	collect();
	propose();
	const { gated } = runGateStage({ runId: RUN_ID, sessionFile });

	assert.equal(fs.readFileSync(target, "utf8"), "untouched\n");
	const prompt = approvalPrompt(gated, RUN_ID);
	assert.match(prompt, /Nothing has been applied/);
	assert.match(prompt, /\/refine apply run1/);
	assert.match(prompt, /\/refine rollback run1/);
});

test("the approval prompt shows refusals, not just what passed", () => {
	// An approval prompt listing only successes would hide the loop's failures
	// from the one person able to notice the gate being talked around.
	collect();
	propose("#design");
	const { gated } = runGateStage({ runId: RUN_ID, sessionFile });

	const prompt = approvalPrompt(gated, RUN_ID);
	assert.match(prompt, /citation-names-missing-evidence/);
	assert.match(prompt, /Nothing is eligible to apply/);
});

test("the evidence stage records the unrecoverable room rather than omitting it", () => {
	const { bundle, summary } = collect();

	assert.equal(bundle.present.length + bundle.missing.length, 2);
	assert.equal(bundle.missing[0]?.label, "#design");
	assert.match(summary, /1 present, 1 missing/);
});

test("proposals are read back in stable order", () => {
	collect();
	runProposeStage({
		runId: RUN_ID,
		sessionFile,
		structuredOutput: {
			proposals: Array.from({ length: 12 }, (_unused, index) => ({
				targetPath: `skills/s${index}.md`,
				diff: "@@",
				justification: "j",
				evidence: [{ source: "session transcript", locator: "1" }],
			})),
		},
	});

	// Zero-padded filenames, so 10 sorts after 9 rather than after 1.
	assert.deepEqual(
		readProposals(sessionFile, RUN_ID).map((proposal) => proposal.targetPath),
		Array.from({ length: 12 }, (_unused, index) => `skills/s${index}.md`),
	);
});
