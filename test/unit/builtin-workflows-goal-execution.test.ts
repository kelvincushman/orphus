import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { describe, test } from "vitest";
import type { GoalExecutionLeafRecord } from "../../packages/workflows/builtin/goal-execution.js";
import { runGoalExecutionPlan } from "../../packages/workflows/builtin/goal-execution.js";
import { normalizeGoalExecutionPlan } from "../../packages/workflows/builtin/goal-plan.js";
import type { WorkflowTaskOptions, WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";

type TaskCall = {
	readonly name: string;
	readonly options: WorkflowTaskOptions;
};

type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settled) => {
		resolve = settled;
	});
	return { promise, resolve };
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await setImmediate();
	}
}

async function waitForCall(calls: readonly TaskCall[], name: string): Promise<boolean> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (calls.some((call) => call.name === name)) {
			return true;
		}
		await setTimeout(5);
	}
	return false;
}

function workerName(turn: number, leafId: string): string {
	return `goal-turn-${turn}-leaf-${leafId}`;
}

function verifierName(turn: number, leafId: string): string {
	return `goal-turn-${turn}-leaf-${leafId}-verify`;
}

function plan() {
	return normalizeGoalExecutionPlan({
		version: 1,
		leaves: [
			{
				id: "1",
				title: "Foundation A",
				task: "Edit A",
				owns: ["packages/a.ts"],
				needs: [],
				tier: "standard",
				checks: [{ command: "npm run check:a", expect: "A passes" }],
			},
			{
				id: "2",
				title: "Foundation B",
				task: "Edit B",
				owns: ["packages/b.ts"],
				needs: [],
				tier: "fast",
				checks: [{ command: "npm run check:b", expect: "B passes" }],
			},
			{
				id: "3",
				title: "Dependant C",
				task: "Edit C",
				owns: ["packages/c.ts"],
				needs: ["1"],
				tier: "judgment",
				checks: [{ command: "npm run check:c", expect: "C passes" }],
			},
		],
	});
}

function result(
	name: string,
	options: WorkflowTaskOptions,
	structured?: WorkflowTaskResult["structured"],
	persistOutput = true,
): WorkflowTaskResult {
	const text = typeof structured === "undefined" ? `${name} complete` : JSON.stringify(structured);
	if (persistOutput && typeof options.output === "string" && !existsSync(options.output)) {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, text, "utf8");
	}
	return {
		name,
		stageName: name,
		text,
		...(structured === undefined ? {} : { structured }),
		...(typeof options.output === "string" ? { sessionFile: `${options.output}.jsonl` } : {}),
	};
}

function verified(name: string, options: WorkflowTaskOptions): WorkflowTaskResult {
	const leaf = plan().leaves.find((candidate) => name.endsWith(`-leaf-${candidate.id}-verify`));
	assert.ok(leaf, `Unknown verifier task ${name}`);
	return result(name, options, {
		status: "verified",
		evidence: `${name} checked owned files and commands`,
		remaining_work: "none",
		checks: leaf.checks.map((check) => ({
			command: check.command,
			expect: check.expect,
			status: "passed",
			evidence: `${check.command} matched ${check.expect}`,
		})),
	});
}

function verificationForLeaf(
	leafId: string,
	override: {
		readonly status?: "verified" | "failed" | "blocked";
		readonly evidence?: string;
		readonly remaining_work?: string;
		readonly checks?: readonly {
			readonly command: string;
			readonly expect: string;
			readonly status: "passed" | "failed" | "blocked";
			readonly evidence: string;
		}[];
	} = {},
) {
	const leaf = plan().leaves.find((candidate) => candidate.id === leafId);
	assert.ok(leaf, `Unknown leaf ${leafId}`);
	return {
		status: override.status ?? "verified",
		evidence: override.evidence ?? `leaf ${leafId} evidenced`,
		remaining_work: override.remaining_work ?? "none",
		checks:
			override.checks ??
			leaf.checks.map((check) => ({
				command: check.command,
				expect: check.expect,
				status: "passed" as const,
				evidence: `${check.command} matched ${check.expect}`,
			})),
	};
}

function assertRecordArtifactsExist(record: GoalExecutionLeafRecord): void {
	assert.equal(statSync(record.task_artifact_path).isFile(), true, record.task_artifact_path);
	assert.equal(statSync(record.verification_artifact_path).isFile(), true, record.verification_artifact_path);
	assert.ok(readFileSync(record.task_artifact_path, "utf8").trim().length > 0, record.task_artifact_path);
	assert.ok(
		readFileSync(record.verification_artifact_path, "utf8").trim().length > 0,
		record.verification_artifact_path,
	);
}

describe("Goal rolling execution plan", () => {
	test("dispatches every initially ready leaf before accepting returns and rolls dependants without a wave barrier", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));
		const calls: TaskCall[] = [];
		const worker1 = deferred<WorkflowTaskResult>();
		const worker2 = deferred<WorkflowTaskResult>();
		const worker3 = deferred<WorkflowTaskResult>();
		const workers = new Map([
			[workerName(1, "1"), worker1],
			[workerName(1, "2"), worker2],
			[workerName(1, "3"), worker3],
		]);

		const reportPromise = runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath: join(artifactDir, "ledger.json"),
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 2,
			turn: 1,
			ctx: {
				task: async (name, options) => {
					calls.push({ name, options });
					const worker = workers.get(name);
					if (worker !== undefined) {
						return worker.promise;
					}
					return verified(name, options);
				},
			},
		});

		await flushPromises();
		assert.deepEqual(
			calls.map((call) => call.name),
			[workerName(1, "1"), workerName(1, "2")],
		);

		worker1.resolve(result(workerName(1, "1"), calls[0].options));
		const dependantStarted = await waitForCall(calls, workerName(1, "3"));
		if (!dependantStarted) {
			worker2.resolve(result(workerName(1, "2"), calls[1].options));
			worker3.resolve(result(workerName(1, "3"), calls[3]?.options ?? calls[1].options));
			await reportPromise.catch(() => undefined);
		}
		assert.equal(dependantStarted, true);
		assert.deepEqual(
			calls.map((call) => call.name),
			[workerName(1, "1"), workerName(1, "2"), verifierName(1, "1"), workerName(1, "3")],
		);

		worker2.resolve(result(workerName(1, "2"), calls[1].options));
		worker3.resolve(result(workerName(1, "3"), calls[3].options));
		const report = await reportPromise;

		assert.equal(report.complete, true);
		assert.deepEqual(report.failed_leaf_ids, []);
		assert.deepEqual(report.blocked_leaf_ids, []);
		const persisted = JSON.parse(readFileSync(report.report_path, "utf8"));
		assert.equal(persisted.complete, true);
		assert.equal(persisted.records[0].check_results[0].status, "passed");
	});

	test("blocks downstream leaves when a dependency fails verification", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));
		const calls: TaskCall[] = [];

		const report = await runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath: join(artifactDir, "ledger.json"),
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 3,
			turn: 1,
			ctx: {
				task: async (name, options) => {
					calls.push({ name, options });
					if (name === verifierName(1, "1")) {
						return result(name, options, {
							status: "failed",
							evidence: "declared check failed",
							remaining_work: "fix A",
							checks: [
								{
									command: "npm run check:a",
									expect: "A passes",
									status: "failed",
									evidence: "A did not pass",
								},
							],
						});
					}
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
		});

		const record3 = report.records.find((record) => record.leaf_id === "3");
		assert.equal(report.complete, false);
		assert.deepEqual(report.failed_leaf_ids, ["1"]);
		assert.deepEqual(report.blocked_leaf_ids, ["3"]);
		assert.equal(
			calls.some((call) => call.name === workerName(1, "3")),
			false,
		);
		assert.match(record3?.evidence ?? "", /Leaf 1 finished with status failed/);
		assert.equal(record3?.check_results[0].status, "blocked");
	});

	test("fails closed on invalid or empty verification", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));

		const report = await runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath: join(artifactDir, "ledger.json"),
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 3,
			turn: 1,
			ctx: {
				task: async (name, options) => {
					if (name === verifierName(1, "1")) {
						return result(name, options, { ok: true });
					}
					if (name === verifierName(1, "2")) {
						return result(name, options, verificationForLeaf("2", { evidence: "" }));
					}
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
		});

		const record1 = report.records.find((record) => record.leaf_id === "1");
		const record2 = report.records.find((record) => record.leaf_id === "2");
		assert.equal(report.complete, false);
		assert.deepEqual(report.failed_leaf_ids, ["1", "2"]);
		assert.deepEqual(report.blocked_leaf_ids, ["3"]);
		assert.match(record1?.remaining_work ?? "", /required schema/);
		assert.match(record2?.evidence ?? "", /empty evidence/);
		assert.equal(record1?.check_results[0].status, "blocked");
	});

	test("fails closed on verified status with remaining work", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));

		const report = await runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath: join(artifactDir, "ledger.json"),
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 1,
			turn: 1,
			ctx: {
				task: async (name, options) => {
					if (name === verifierName(1, "1")) {
						return result(name, options, verificationForLeaf("1", { remaining_work: "one check still missing" }));
					}
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
		});

		const record1 = report.records.find((record) => record.leaf_id === "1");
		assert.equal(report.complete, false);
		assert.equal(record1?.status, "failed");
		assert.match(record1?.evidence ?? "", /contradicted itself/);
		assert.deepEqual(report.blocked_leaf_ids, ["3"]);
	});

	test("fails closed on failed or blocked status with empty remaining work", async () => {
		for (const status of ["failed", "blocked"] as const) {
			const artifactDir = mkdtempSync(join(tmpdir(), `goal-execution-${status}-`));
			const report = await runGoalExecutionPlan({
				plan: plan(),
				objective: "ship the plan",
				acceptanceCriteria: "all leaves verified",
				ledgerPath: join(artifactDir, "ledger.json"),
				artifactDir,
				workflowStartCwd: process.cwd(),
				maxParallelAgents: 1,
				turn: 1,
				ctx: {
					task: async (name, options) => {
						if (name === verifierName(1, "1")) {
							return result(name, options, verificationForLeaf("1", { status, remaining_work: "" }));
						}
						return name.endsWith("-verify") ? verified(name, options) : result(name, options);
					},
				},
			});

			const record1 = report.records.find((record) => record.leaf_id === "1");
			assert.equal(report.complete, false, status);
			assert.equal(record1?.status, "failed", status);
			assert.match(record1?.evidence ?? "", /empty remaining_work/, status);
		}
	});

	test("fails closed on missing, extra, mismatched, empty, or non-passed checks", async () => {
		const cases = [
			{
				name: "missing",
				checks: [],
				message: /0 check results for 1 declared checks/,
			},
			{
				name: "extra",
				checks: [
					{ command: "npm run check:a", expect: "A passes", status: "passed" as const, evidence: "ok" },
					{ command: "npm run check:extra", expect: "Extra passes", status: "passed" as const, evidence: "ok" },
				],
				message: /2 check results for 1 declared checks/,
			},
			{
				name: "mismatched",
				checks: [{ command: "npm run check:wrong", expect: "A passes", status: "passed" as const, evidence: "ok" }],
				message: /did not match the frozen command\/expect pair/,
			},
			{
				name: "empty check evidence",
				checks: [{ command: "npm run check:a", expect: "A passes", status: "passed" as const, evidence: "" }],
				message: /empty evidence/,
			},
			{
				name: "non-passed",
				checks: [
					{
						command: "npm run check:a",
						expect: "A passes",
						status: "blocked" as const,
						evidence: "tool unavailable",
					},
				],
				message: /one or more declared checks did not pass/,
			},
		];

		for (const testCase of cases) {
			const artifactDir = mkdtempSync(join(tmpdir(), `goal-execution-${testCase.name}-`));
			const report = await runGoalExecutionPlan({
				plan: plan(),
				objective: "ship the plan",
				acceptanceCriteria: "all leaves verified",
				ledgerPath: join(artifactDir, "ledger.json"),
				artifactDir,
				workflowStartCwd: process.cwd(),
				maxParallelAgents: 1,
				turn: 1,
				ctx: {
					task: async (name, options) => {
						if (name === verifierName(1, "1")) {
							return result(name, options, verificationForLeaf("1", { checks: testCase.checks }));
						}
						return name.endsWith("-verify") ? verified(name, options) : result(name, options);
					},
				},
			});

			const record1 = report.records.find((record) => record.leaf_id === "1");
			assert.equal(report.complete, false, testCase.name);
			assert.equal(record1?.status, "failed", testCase.name);
			assert.match(record1?.evidence ?? "", testCase.message, testCase.name);
			assert.deepEqual(record1?.check_results, testCase.checks, testCase.name);
		}
	});

	test("fails closed and preserves reordered or duplicate check results", async () => {
		const twoCheckPlan = normalizeGoalExecutionPlan({
			version: 1,
			leaves: [
				{
					id: "1",
					title: "Two checks",
					task: "Edit A",
					owns: ["packages/a.ts"],
					needs: [],
					tier: "standard",
					checks: [
						{ command: "npm run check:a", expect: "A passes" },
						{ command: "npm run check:b", expect: "B passes" },
					],
				},
			],
		});
		const cases = [
			{
				name: "reordered",
				checks: [
					{ command: "npm run check:b", expect: "B passes", status: "passed" as const, evidence: "ok" },
					{ command: "npm run check:a", expect: "A passes", status: "passed" as const, evidence: "ok" },
				],
				message: /did not match the frozen command\/expect pair/,
			},
			{
				name: "duplicate",
				checks: [
					{ command: "npm run check:a", expect: "A passes", status: "passed" as const, evidence: "ok" },
					{ command: "npm run check:a", expect: "A passes", status: "passed" as const, evidence: "ok" },
				],
				message: /duplicated check result/,
			},
		];

		for (const testCase of cases) {
			const artifactDir = mkdtempSync(join(tmpdir(), `goal-execution-${testCase.name}-`));
			const report = await runGoalExecutionPlan({
				plan: twoCheckPlan,
				objective: "ship the plan",
				acceptanceCriteria: "all leaves verified",
				ledgerPath: join(artifactDir, "ledger.json"),
				artifactDir,
				workflowStartCwd: process.cwd(),
				maxParallelAgents: 1,
				turn: 1,
				ctx: {
					task: async (name, options) =>
						name.endsWith("-verify")
							? result(name, options, {
									status: "verified",
									evidence: "bad results",
									remaining_work: "none",
									checks: testCase.checks,
								})
							: result(name, options),
				},
			});

			const record1 = report.records.find((record) => record.leaf_id === "1");
			assert.equal(report.complete, false, testCase.name);
			assert.equal(record1?.status, "failed", testCase.name);
			assert.match(record1?.evidence ?? "", testCase.message, testCase.name);
			assert.deepEqual(record1?.check_results, testCase.checks, testCase.name);
		}
	});

	test("uses distinct stage and artifact namespaces for distinct turns", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));
		const calls: TaskCall[] = [];

		const runTurn = (turn: number) =>
			runGoalExecutionPlan({
				plan: plan(),
				objective: "ship the plan",
				acceptanceCriteria: "all leaves verified",
				ledgerPath: join(artifactDir, "ledger.json"),
				artifactDir,
				workflowStartCwd: process.cwd(),
				maxParallelAgents: 1,
				turn,
				ctx: {
					task: async (name, options) => {
						calls.push({ name, options });
						return name.endsWith("-verify") ? verified(name, options) : result(name, options);
					},
				},
			});

		const turn1 = await runTurn(1);
		const turn2 = await runTurn(2);

		assert.equal(turn1.report_path, join(artifactDir, "turn-1-goal-execution-report.json"));
		assert.equal(turn2.report_path, join(artifactDir, "turn-2-goal-execution-report.json"));
		assert.equal(
			calls.some((call) => call.name === workerName(1, "1")),
			true,
		);
		assert.equal(
			calls.some((call) => call.name === workerName(2, "1")),
			true,
		);
		assert.equal(turn1.records[0].task_artifact_path, join(artifactDir, "turn-1-leaf-1-receipt.md"));
		assert.equal(turn2.records[0].task_artifact_path, join(artifactDir, "turn-2-leaf-1-receipt.md"));
		for (const record of [...turn1.records, ...turn2.records]) {
			assertRecordArtifactsExist(record);
		}
	});

	test("synthesizes readable artifacts for worker and verifier failure paths", async () => {
		const cases = [
			{
				name: "worker throw",
				task: async (name: string, options: WorkflowTaskOptions) => {
					if (name === workerName(1, "1")) {
						throw new Error("worker exploded");
					}
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
			{
				name: "invalid verifier schema",
				task: async (name: string, options: WorkflowTaskOptions) =>
					name === verifierName(1, "1")
						? result(name, options, { ok: true })
						: name.endsWith("-verify")
							? verified(name, options)
							: result(name, options),
			},
			{
				name: "verifier throw",
				task: async (name: string, options: WorkflowTaskOptions) => {
					if (name === verifierName(1, "1")) {
						throw new Error("verifier exploded");
					}
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
		];

		for (const testCase of cases) {
			const artifactDir = mkdtempSync(join(tmpdir(), `goal-execution-${testCase.name}-`));
			const report = await runGoalExecutionPlan({
				plan: plan(),
				objective: "ship the plan",
				acceptanceCriteria: "all leaves verified",
				ledgerPath: join(artifactDir, "ledger.json"),
				artifactDir,
				workflowStartCwd: process.cwd(),
				maxParallelAgents: 1,
				turn: 1,
				ctx: { task: testCase.task },
			});

			assert.equal(report.complete, false, testCase.name);
			for (const record of report.records) {
				assertRecordArtifactsExist(record);
				const verification = JSON.parse(readFileSync(record.verification_artifact_path, "utf8"));
				if (verification.synthesized === true) {
					assert.equal(verification.record.leaf_id, record.leaf_id, testCase.name);
				} else if (verification.record !== undefined) {
					assert.equal(verification.record.leaf_id, record.leaf_id, testCase.name);
				} else if (verification.ok === true) {
					assert.equal(testCase.name, "invalid verifier schema");
				} else {
					assert.equal(verification.status, "verified", testCase.name);
					assert.equal(verification.remaining_work, "none", testCase.name);
				}
			}
		}
	});

	test("fails closed when verified leaves do not persist worker or verifier evidence artifacts", async () => {
		const cases = [
			{
				name: "missing worker artifact",
				task: (taskName: string, options: WorkflowTaskOptions) =>
					taskName === workerName(1, "1")
						? result(taskName, options, undefined, false)
						: taskName.endsWith("-verify")
							? verified(taskName, options)
							: result(taskName, options),
				missing: /turn-1-leaf-1-receipt\.md/,
			},
			{
				name: "missing verifier artifact",
				task: (taskName: string, options: WorkflowTaskOptions) =>
					taskName === verifierName(1, "1")
						? result(taskName, options, verificationForLeaf("1"), false)
						: taskName.endsWith("-verify")
							? verified(taskName, options)
							: result(taskName, options),
				missing: /turn-1-leaf-1-verification\.json/,
			},
			{
				name: "blank verifier artifact",
				task: (taskName: string, options: WorkflowTaskOptions) => {
					if (taskName === verifierName(1, "1")) {
						if (typeof options.output !== "string") throw new Error("expected verifier output path");
						mkdirSync(dirname(options.output), { recursive: true });
						writeFileSync(options.output, "   \n", "utf8");
						return result(taskName, options, verificationForLeaf("1"), false);
					}
					return taskName.endsWith("-verify") ? verified(taskName, options) : result(taskName, options);
				},
				missing: /turn-1-leaf-1-verification\.json/,
			},
		] as const;

		for (const testCase of cases) {
			const artifactDir = mkdtempSync(join(tmpdir(), `goal-execution-${testCase.name}-`));
			const report = await runGoalExecutionPlan({
				plan: plan(),
				objective: "ship the plan",
				acceptanceCriteria: "all leaves verified",
				ledgerPath: join(artifactDir, "ledger.json"),
				artifactDir,
				workflowStartCwd: process.cwd(),
				maxParallelAgents: 1,
				turn: 1,
				ctx: { task: async (name, options) => testCase.task(name, options) },
			});

			const record1 = report.records.find((record) => record.leaf_id === "1");
			assert.equal(report.complete, false, testCase.name);
			assert.deepEqual(report.failed_leaf_ids, ["1"], testCase.name);
			assert.equal(record1?.status, "failed", testCase.name);
			assert.match(record1?.evidence ?? "", /did not persist non-empty primary evidence artifacts/i, testCase.name);
			assert.match(record1?.evidence ?? "", testCase.missing, testCase.name);
			assert.match(record1?.remaining_work ?? "", /worker receipt and verifier artifact/i, testCase.name);
			assert.deepEqual(report.blocked_leaf_ids, ["3"], testCase.name);
			assert.ok(record1);
			assertRecordArtifactsExist(record1);
		}
	});

	test("rejects invalid execution concurrency before dispatch", async () => {
		for (const maxParallelAgents of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5]) {
			const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-invalid-concurrency-"));
			await assert.rejects(
				() =>
					runGoalExecutionPlan({
						plan: plan(),
						objective: "ship the plan",
						acceptanceCriteria: "all leaves verified",
						ledgerPath: join(artifactDir, "ledger.json"),
						artifactDir,
						workflowStartCwd: process.cwd(),
						maxParallelAgents,
						turn: 1,
						ctx: {
							task: async (name, options) =>
								name.endsWith("-verify") ? verified(name, options) : result(name, options),
						},
					}),
				/positive finite integer/,
			);
		}
	});

	test("synthesizes artifacts for dependency-blocked leaves", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));
		const report = await runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath: join(artifactDir, "ledger.json"),
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 1,
			turn: 2,
			ctx: {
				task: async (name, options) =>
					name === verifierName(2, "1")
						? result(name, options, verificationForLeaf("1", { status: "failed", remaining_work: "fix it" }))
						: name.endsWith("-verify")
							? verified(name, options)
							: result(name, options),
			},
		});

		const blocked = report.records.find((record) => record.leaf_id === "3");
		assert.ok(blocked);
		assert.equal(blocked.task_artifact_path, join(artifactDir, "turn-2-leaf-3-receipt.md"));
		assert.equal(blocked.verification_artifact_path, join(artifactDir, "turn-2-leaf-3-verification.json"));
		assertRecordArtifactsExist(blocked);
		assert.match(readFileSync(blocked.verification_artifact_path, "utf8"), /dependency path failed closed/);
	});

	test("does not overwrite genuine model artifacts", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));
		const report = await runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath: join(artifactDir, "ledger.json"),
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 1,
			turn: 3,
			ctx: {
				task: async (name, options) => {
					if (typeof options.output === "string") {
						writeFileSync(options.output, `genuine ${name}`, "utf8");
					}
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
		});

		const record1 = report.records[0];
		assert.equal(readFileSync(record1.task_artifact_path, "utf8"), "genuine goal-turn-3-leaf-1");
		assert.equal(readFileSync(record1.verification_artifact_path, "utf8"), "genuine goal-turn-3-leaf-1-verify");
	});

	test("uses a separate verifier primary and exact leaf prompt artifact contract", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "goal-execution-test-"));
		const calls: TaskCall[] = [];
		const ledgerPath = join(artifactDir, "ledger.json");

		const report = await runGoalExecutionPlan({
			plan: plan(),
			objective: "ship the plan",
			acceptanceCriteria: "all leaves verified",
			ledgerPath,
			artifactDir,
			workflowStartCwd: process.cwd(),
			maxParallelAgents: 1,
			turn: 1,
			ctx: {
				task: async (name, options) => {
					calls.push({ name, options });
					return name.endsWith("-verify") ? verified(name, options) : result(name, options);
				},
			},
		});

		const worker = calls.find((call) => call.name === workerName(1, "1"));
		const verifier = calls.find((call) => call.name === verifierName(1, "1"));
		assert.equal(report.complete, true);
		assert.ok(worker);
		assert.ok(verifier);
		assert.notEqual(worker.options.model, verifier.options.model);
		assert.deepEqual(worker.options.reads, [ledgerPath]);
		assert.deepEqual(verifier.options.reads, [ledgerPath, join(artifactDir, "turn-1-leaf-1-receipt.md")]);
		assert.equal(worker.options.output, join(artifactDir, "turn-1-leaf-1-receipt.md"));
		assert.equal(worker.options.outputMode, "file-only");
		assert.equal(verifier.options.output, join(artifactDir, "turn-1-leaf-1-verification.json"));
		assert.equal(verifier.options.outputMode, "file-only");
		assert.match(worker.options.prompt ?? "", /Receipt artifact path:/);
		assert.match(worker.options.prompt ?? "", /Verification artifact path:/);
		assert.match(verifier.options.prompt ?? "", /Leaf receipt artifact:/);
		assert.match(verifier.options.prompt ?? "", /actually run every safe declared check/i);
		assert.match(verifier.options.prompt ?? "", /one checks\[\] entry for every declared check/i);
		assert.match(worker.options.prompt ?? "", /Foundation A/);
		assert.doesNotMatch(worker.options.prompt ?? "", /Foundation B/);
		assert.doesNotMatch(verifier.options.prompt ?? "", /Dependant C/);
	});
});
