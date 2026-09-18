import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * A run directory shaped like one Goal leaves behind: a ledger, the turn's
 * plan, its execution report, the worker receipts, and optionally the System
 * One receipts.
 */
function makeRun(runsDir, name, { withReceipts = false, leafStatus = "verified", firstTry = true } = {}) {
	const dir = join(runsDir, name);
	mkdirSync(dir, { recursive: true });

	writeFileSync(
		join(dir, "goal-ledger.json"),
		JSON.stringify({
			goal_id: name,
			status: "complete",
			reviews: [
				{
					reviewer: "opus",
					decision: "complete",
					requirements_traceability: [{ requirement: "ship it", status: "proven", evidence: "npm test passed" }],
					receipt_assessment: "receipts inspected",
					verification_remaining: "none",
					findings: [],
				},
				{ reviewer: "codex", decision: "continue", requirements_traceability: [], findings: [] },
			],
		}),
	);

	writeFileSync(
		join(dir, "goal-execution-plan-turn-1.json"),
		JSON.stringify({
			version: 1,
			leaves: [
				{
					id: "1",
					title: "Do the thing",
					task: "Implement the thing",
					owns: ["packages/thing.ts"],
					needs: [],
					tier: "standard",
					checks: [{ command: "npm run check", expect: "passes" }],
				},
			],
		}),
	);

	writeFileSync(
		join(dir, "turn-1-goal-execution-report.json"),
		JSON.stringify({
			complete: leafStatus === "verified",
			records: [
				{
					leaf_id: "1",
					title: "Do the thing",
					tier: "standard",
					status: leafStatus,
					evidence: "did it",
					check_results: [
						{ command: "npm run check", expect: "passes", status: "passed", evidence: "check passed" },
					],
					model_attempts: firstTry
						? [{ model: "openai/gpt", success: true }]
						: [
								{ model: "openai/gpt", success: false, error: "overloaded" },
								{ model: "anthropic/claude", success: true },
							],
				},
			],
		}),
	);

	writeFileSync(join(dir, "turn-1-leaf-1-receipt.md"), "# Receipt\n\nRan npm run check, it passed.\n");

	if (withReceipts) {
		writeFileSync(
			join(dir, "turn-1-systemone-receipts.jsonl"),
			[
				JSON.stringify({
					surface: "goal.tier",
					question_key: "reasoning_required",
					kind: "score",
					value: 1,
					p: 0.8,
					confidence: 0.7,
					threshold: 0.8,
					abstain: true,
					adapter_id: "local:qwen3-4b",
					calibrated: false,
					state_hash: "a".repeat(32),
					question_hash: "b".repeat(32),
					ts: "2026-09-18T00:00:00.000Z",
					context: { leaf_id: "1", planner_tier: "standard" },
				}),
				JSON.stringify({
					surface: "goal.review",
					question_key: "evidence_supports_stop",
					kind: "noul",
					value: true,
					p: 0.95,
					confidence: 0.9,
					threshold: 0.9,
					abstain: false,
					adapter_id: "local:qwen3-4b",
					calibrated: false,
					state_hash: "c".repeat(32),
					question_hash: "d".repeat(32),
					ts: "2026-09-18T00:00:00.000Z",
					context: { reviewer: "opus" },
				}),
				"",
			].join("\n"),
		);
	}
	return dir;
}

function harvest(runsDir, extraArgs = []) {
	const bun = process.env.ORPHUS_BUN_EXECUTABLE || "bun";
	const result = spawnSync(bun, ["run", "scripts/systemone-labels.ts", "--runs-dir", runsDir, ...extraArgs], {
		cwd: root,
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.equal(result.status, 0, `harvester failed:\n${result.stdout}\n${result.stderr}`);
	const rows = result.stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
	return { rows, stderr: result.stderr };
}

test("harvests a tier, review and check label from one finished run", () => {
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		makeRun(runsDir, "run-1");
		const { rows } = harvest(runsDir);

		const tier = rows.find((row) => row.surface === "goal.tier");
		assert.ok(tier, "a verified leaf yields a tier label");
		assert.equal(tier.label, "standard");
		assert.equal(tier.kind, "score");
		assert.match(tier.outcome, /first model attempt/);
		assert.equal(tier.state.task, "Implement the thing");
		assert.equal(JSON.stringify(tier.state).includes("standard"), false, "the state must not leak its own label");

		const review = rows.find((row) => row.surface === "goal.review");
		assert.ok(review, "an approving reviewer yields a review label");
		assert.equal(review.label, true, "the run completed, so the approval is supported");
		assert.equal(review.state.requirements[0].status, "proven");

		const check = rows.find((row) => row.surface === "goal.verify");
		assert.ok(check, "a check result yields a check label");
		assert.equal(check.label, true);
		assert.match(check.state.worker_receipt, /Ran npm run check/);
		assert.match(check.outcome, /verifier reported passed/);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("labels a run with no System One receipts, since the outcomes do not need them", () => {
	// Runs predating the layer are the only training data there is until new
	// ones accumulate; skipping them would leave the first calibration with
	// nothing to fit on.
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		makeRun(runsDir, "old-run", { withReceipts: false });
		const { rows } = harvest(runsDir);

		assert.ok(rows.length > 0);
		for (const row of rows) {
			assert.equal(row.has_receipt, false);
			assert.equal(row.receipt, undefined);
		}
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("joins a receipt to the label it predicted, keyed by what it judged", () => {
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		makeRun(runsDir, "new-run", { withReceipts: true });
		const { rows } = harvest(runsDir);

		const tier = rows.find((row) => row.surface === "goal.tier");
		assert.equal(tier.has_receipt, true);
		assert.equal(tier.receipt.adapter_id, "local:qwen3-4b");
		assert.equal(tier.receipt.abstain, true, "an abstention is still a prediction worth scoring");
		assert.match(tier.receipt.question_hash, /^b+$/);

		const review = rows.find((row) => row.surface === "goal.review");
		assert.equal(review.receipt.value, true);
		assert.equal(review.receipt.calibrated, false);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("records when a leaf needed more than its first model attempt", () => {
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		makeRun(runsDir, "ladder-run", { firstTry: false });
		const { rows } = harvest(runsDir);
		const tier = rows.find((row) => row.surface === "goal.tier");
		assert.match(tier.outcome, /after 2 model attempts/, "an under-tiered leaf must be distinguishable");
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("does not label a leaf that never verified", () => {
	// Its tier is not evidence of anything: the work did not land.
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		makeRun(runsDir, "failed-run", { leafStatus: "failed" });
		const { rows } = harvest(runsDir);
		assert.equal(
			rows.some((row) => row.surface === "goal.tier"),
			false,
		);
		assert.ok(
			rows.some((row) => row.surface === "goal.verify"),
			"the check results are still labelled",
		);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("reports an empty harvest plainly instead of failing", () => {
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		const { rows, stderr } = harvest(runsDir);
		assert.deepEqual(rows, []);
		assert.match(stderr, /No labels found/);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("ignores a directory that is not a Goal run", () => {
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		mkdirSync(join(runsDir, "some-other-run"), { recursive: true });
		writeFileSync(join(runsDir, "some-other-run", "notes.txt"), "not a goal run");
		makeRun(runsDir, "real-run");
		const { rows } = harvest(runsDir);
		assert.ok(rows.every((row) => row.run === "real-run"));
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("writes to a file when asked, creating its directory", () => {
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		makeRun(runsDir, "run-1");
		const out = join(runsDir, "nested", "labels.jsonl");
		const { rows } = harvest(runsDir, ["--out", out]);
		assert.deepEqual(rows, [], "rows go to the file, not stdout");
		const written = spawnSync("cat", [out], { encoding: "utf8" });
		assert.ok(written.stdout.split("\n").filter(Boolean).length > 0);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});
