import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("harvests against the highest turn, not the last one alphabetically", () => {
	// Sorting the file names as strings puts turn 9 after turn 10, so a run that
	// reached double figures would be labelled against a superseded plan and a
	// superseded report. `max_turns` is a user input, so that run is reachable.
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		const dir = makeRun(runsDir, "long-run");
		rmSync(join(dir, "goal-execution-plan-turn-1.json"));
		rmSync(join(dir, "turn-1-goal-execution-report.json"));

		for (const [turn, task, status] of [
			[9, "The ninth plan", "failed"],
			[10, "The tenth plan", "verified"],
		]) {
			writeFileSync(
				join(dir, `goal-execution-plan-turn-${turn}.json`),
				JSON.stringify({
					version: 1,
					leaves: [
						{
							id: "1",
							title: "Do the thing",
							task,
							owns: ["packages/thing.ts"],
							needs: [],
							tier: "standard",
							checks: [{ command: "npm run check", expect: "passes" }],
						},
					],
				}),
			);
			writeFileSync(
				join(dir, `turn-${turn}-goal-execution-report.json`),
				JSON.stringify({
					complete: status === "verified",
					records: [
						{
							leaf_id: "1",
							title: "Do the thing",
							tier: "standard",
							status,
							evidence: "did it",
							check_results: [
								{ command: "npm run check", expect: "passes", status: "passed", evidence: "check passed" },
							],
							model_attempts: [{ model: "openai/gpt", success: true }],
						},
					],
				}),
			);
		}

		const { rows } = harvest(runsDir);
		const tier = rows.find((row) => row.surface === "goal.tier");
		assert.ok(tier, "turn 10 verified the leaf, so it yields a tier label");
		assert.equal(tier.state.task, "The tenth plan");
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("pairs a check label with the worker receipt of the turn it was harvested from", () => {
	// The check results come from one turn's report, so the receipt must come
	// from that same turn. Matching by leaf suffix alone took whatever `readdir`
	// returned first, so a leaf re-planned after a failure could have turn 2's
	// verdict labelled against turn 1's work.
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		const dir = makeRun(runsDir, "replanned-run");
		writeFileSync(join(dir, "turn-1-leaf-1-receipt.md"), "# Receipt\n\nThe first attempt, which failed.\n");
		writeFileSync(join(dir, "turn-2-leaf-1-receipt.md"), "# Receipt\n\nThe second attempt, which passed.\n");
		for (const name of ["goal-execution-plan-turn-1.json", "turn-1-goal-execution-report.json"]) {
			writeFileSync(join(dir, name.replace("turn-1", "turn-2")), readFileSync(join(dir, name), "utf8"));
		}

		const { rows } = harvest(runsDir);
		const check = rows.find((row) => row.surface === "goal.verify");
		assert.ok(check, "the run has a check result to label");
		assert.match(check.state.worker_receipt, /second attempt/);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("skips a check label whose harvested turn left no worker receipt", () => {
	// The discriminating case, because it does not depend on `readdir` order: the
	// run was re-planned to turn 2 but only turn 1 wrote a receipt. Matching by
	// suffix finds turn 1's and emits a row pairing turn 2's verdict with turn
	// 1's work. There is no correct label here, and a mislabelled example is
	// worse than a missing one — it trains on a lie.
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		const dir = makeRun(runsDir, "orphaned-receipt-run");
		for (const name of ["goal-execution-plan-turn-1.json", "turn-1-goal-execution-report.json"]) {
			writeFileSync(join(dir, name.replace("turn-1", "turn-2")), readFileSync(join(dir, name), "utf8"));
		}

		const { rows } = harvest(runsDir);
		assert.equal(
			rows.filter((row) => row.surface === "goal.verify").length,
			0,
			"turn 2 wrote no receipt, so its check results have nothing to be labelled against",
		);
		// The turns that are self-consistent still label, so this is a narrowed
		// join rather than a harvester that quietly stopped producing check rows.
		assert.ok(rows.some((row) => row.surface === "goal.tier"));
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("marks has_receipt per row, not per surface", () => {
	// The column exists so the set can be partitioned into what the layer
	// predicted and what it did not — which is exactly the split a calibration
	// fit needs. Asking whether the run holds *any* receipt on the surface
	// answers `true` for every row whose siblings were decided while it was not,
	// and the layer abstaining on some leaves and not others is the normal case.
	const runsDir = mkdtempSync(join(tmpdir(), "orphus-labels-"));
	try {
		const dir = makeRun(runsDir, "partly-decided-run", { withReceipts: true });
		// A second verified leaf, with no receipt of its own.
		for (const [file, key, extra] of [
			[
				"goal-execution-plan-turn-1.json",
				"leaves",
				{
					id: "2",
					title: "Do the other thing",
					task: "Implement the other thing",
					owns: ["packages/other.ts"],
					needs: [],
					tier: "fast",
					checks: [{ command: "npm run check", expect: "passes" }],
				},
			],
			[
				"turn-1-goal-execution-report.json",
				"records",
				{
					leaf_id: "2",
					title: "Do the other thing",
					tier: "fast",
					status: "verified",
					evidence: "did it",
					check_results: [
						{ command: "npm run check", expect: "passes", status: "passed", evidence: "check passed" },
					],
					model_attempts: [{ model: "openai/gpt", success: true }],
				},
			],
		]) {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
			parsed[key].push(extra);
			writeFileSync(join(dir, file), JSON.stringify(parsed));
		}
		writeFileSync(join(dir, "turn-1-leaf-2-receipt.md"), "# Receipt\n\nRan npm run check, it passed.\n");

		const { rows } = harvest(runsDir);
		const decided = rows.find((row) => row.surface === "goal.tier" && row.state.task === "Implement the thing");
		const undecided = rows.find(
			(row) => row.surface === "goal.tier" && row.state.task === "Implement the other thing",
		);
		assert.ok(decided && undecided, "both verified leaves yield a tier row");
		assert.equal(decided.has_receipt, true);
		assert.ok(decided.receipt, "the decided leaf carries the receipt it reports");
		assert.equal(undecided.has_receipt, false, "leaf 2 has no receipt of its own, whatever leaf 1 had");
		assert.equal(undecided.receipt, undefined);

		// And the invariant behind the column, over every row the run produced.
		for (const row of rows)
			assert.equal(row.has_receipt, row.receipt !== undefined, `${row.surface} ${row.question_key}`);
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
