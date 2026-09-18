#!/usr/bin/env bun

/**
 * Turn finished Goal runs into training examples.
 *
 * Every Goal run already records what it decided and what happened next: which
 * tier a leaf was given and whether its first model attempt succeeded, what a
 * reviewer claimed and whether the run completed, what a check expected and
 * what the verifier found. Those are labelled decisions. Nothing was reading
 * them.
 *
 * This walks the run artifacts and writes one JSON Lines row per label, so a
 * calibration — and later a fine-tune — can be fitted on what Orphus actually
 * did rather than on a benchmark that resembles it.
 *
 * Runs that predate the System One layer are harvested too: the labels come
 * from the plan, the execution report and the reviews, none of which needed
 * this layer to exist. Where a run does carry receipts, they are joined on, so
 * a row can also say what the layer predicted at the time and under which
 * version of the question's wording.
 *
 * Usage:
 *   bun run scripts/systemone-labels.ts [--runs-dir <path>] [--out <file.jsonl>] [--quiet]
 *
 * With no --out, rows go to stdout, so the usual shell tools work:
 *   bun run scripts/systemone-labels.ts | jq -r 'select(.question_key=="reasoning_required") | .label'
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One labelled decision: what was true, and what happened. */
interface LabelRow {
	/** The Goal run this came from, so a row can be traced back. */
	readonly run: string;
	readonly surface: "goal.tier" | "goal.review" | "goal.verify";
	readonly question_key: string;
	readonly kind: "noul" | "choice" | "score";
	/** What the question would have been asked about. */
	readonly state: unknown;
	/** The answer the outcome supports. */
	readonly label: boolean | string | number;
	/** How the label was established, in a form a human can check. */
	readonly outcome: string;
	readonly has_receipt: boolean;
	/** What the layer actually predicted at the time, when it was running. */
	readonly receipt?: {
		readonly value: boolean | string | number;
		readonly p: number;
		readonly confidence: number;
		readonly abstain: boolean;
		readonly adapter_id: string;
		readonly calibrated: boolean;
		readonly question_hash: string;
	};
}

interface Receipt {
	readonly surface: string;
	readonly question_key: string;
	readonly value: boolean | string | number;
	readonly p: number;
	readonly confidence: number;
	readonly abstain: boolean;
	readonly adapter_id: string;
	readonly calibrated: boolean;
	readonly question_hash: string;
	readonly context?: Record<string, string>;
}

interface PlanLeaf {
	readonly id: string;
	readonly title: string;
	readonly task: string;
	readonly owns: readonly string[];
	readonly needs: readonly string[];
	readonly tier: string;
	readonly checks: readonly { command: string; expect: string }[];
}

interface ExecutionRecord {
	readonly leaf_id: string;
	readonly status: string;
	readonly evidence: string;
	readonly check_results: readonly { command: string; expect: string; status: string; evidence: string }[];
	readonly model_attempts?: readonly { model: string; success: boolean }[];
}

interface Ledger {
	readonly goal_id?: string;
	readonly status?: string;
	readonly reviews?: readonly {
		readonly reviewer: string;
		readonly decision: string;
		readonly requirements_traceability?: readonly { requirement: string; status: string; evidence: string }[];
		readonly receipt_assessment?: string;
		readonly verification_remaining?: string;
		readonly findings?: readonly { title: string; body: string }[];
	}[];
	readonly decisions?: readonly { readonly decision: string; readonly reason?: string }[];
}

/** Where Goal keeps its run artifacts, honouring the same overrides the runtime does. */
export function defaultRunsDir(env: NodeJS.ProcessEnv = process.env): string {
	const artifactRoot = env.ORPHUS_WORKFLOW_ARTIFACT_DIR ?? env.PI_WORKFLOW_ARTIFACT_DIR;
	if (artifactRoot) return join(artifactRoot, "runs");
	const agentDir = env.ORPHUS_CODING_AGENT_DIR ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".orphus", "agent");
	return join(dirname(agentDir), "workflows", "runs");
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Receipts for a run, keyed by surface, so a label can be joined to its prediction. */
async function readReceipts(runDir: string): Promise<Map<string, Receipt[]>> {
	const bySurface = new Map<string, Receipt[]>();
	let names: string[];
	try {
		names = await readdir(runDir);
	} catch {
		return bySurface;
	}
	for (const name of names.filter((entry) => entry.endsWith("-systemone-receipts.jsonl"))) {
		const text = await readFile(join(runDir, name), "utf8").catch(() => "");
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const receipt = JSON.parse(line) as Receipt;
				const existing = bySurface.get(receipt.surface) ?? [];
				existing.push(receipt);
				bySurface.set(receipt.surface, existing);
			} catch {
				// A truncated final line is the normal shape of a killed run.
			}
		}
	}
	return bySurface;
}

function receiptFor(
	receipts: Map<string, Receipt[]>,
	surface: string,
	matches: (receipt: Receipt) => boolean,
): LabelRow["receipt"] | undefined {
	const found = (receipts.get(surface) ?? []).find(matches);
	if (found === undefined) return undefined;
	return {
		value: found.value,
		p: found.p,
		confidence: found.confidence,
		abstain: found.abstain,
		adapter_id: found.adapter_id,
		calibrated: found.calibrated,
		question_hash: found.question_hash,
	};
}

/**
 * Tier labels: which tier the leaf was run at, and whether that worked first time.
 *
 * The label is the tier that succeeded on the first model attempt. A leaf that
 * needed a second rung was under-tiered, and one that succeeded immediately at
 * `judgment` may have been over-tiered — but only the first of those is
 * evidence, so a leaf whose ladder was walked is labelled and one that was not
 * carries its tier with a weaker outcome note.
 */
function tierRows(input: {
	readonly run: string;
	readonly leaves: readonly PlanLeaf[];
	readonly records: readonly ExecutionRecord[];
	readonly receipts: Map<string, Receipt[]>;
}): LabelRow[] {
	const byId = new Map(input.records.map((record) => [record.leaf_id, record]));
	const rows: LabelRow[] = [];
	for (const leaf of input.leaves) {
		const record = byId.get(leaf.id);
		if (record === undefined || record.status !== "verified") continue;
		const attempts = record.model_attempts ?? [];
		const firstTry = attempts.length === 0 ? undefined : attempts[0]?.success === true;
		rows.push({
			run: input.run,
			surface: "goal.tier",
			question_key: "reasoning_required",
			kind: "score",
			state: {
				title: leaf.title,
				task: leaf.task,
				owns: [...leaf.owns],
				depends_on: [...leaf.needs],
				checks: leaf.checks.map((check) => ({ command: check.command, expect: check.expect })),
			},
			label: leaf.tier,
			outcome:
				firstTry === undefined
					? "verified; no model attempts recorded"
					: firstTry
						? "verified on the first model attempt"
						: `verified after ${attempts.length} model attempts`,
			has_receipt: input.receipts.has("goal.tier"),
			...(() => {
				const receipt = receiptFor(input.receipts, "goal.tier", (entry) => entry.context?.leaf_id === leaf.id);
				return receipt === undefined ? {} : { receipt };
			})(),
		});
	}
	return rows;
}

/** Review labels: did the run this reviewer approved actually complete? */
function reviewRows(input: {
	readonly run: string;
	readonly ledger: Ledger;
	readonly receipts: Map<string, Receipt[]>;
}): LabelRow[] {
	const completed = input.ledger.status === "complete";
	return (input.ledger.reviews ?? [])
		.filter((review) => review.decision === "complete")
		.map((review) => ({
			run: input.run,
			surface: "goal.review" as const,
			question_key: "evidence_supports_stop",
			kind: "noul" as const,
			state: {
				requirements: (review.requirements_traceability ?? []).map((entry) => ({
					requirement: entry.requirement,
					status: entry.status,
					evidence: entry.evidence,
				})),
				receipt_assessment: review.receipt_assessment ?? "",
				verification_remaining: review.verification_remaining ?? "",
				open_findings: (review.findings ?? []).map((finding) => `${finding.title}: ${finding.body}`),
			},
			label: completed,
			outcome: `run ended as ${input.ledger.status ?? "unknown"}`,
			has_receipt: input.receipts.has("goal.review"),
			...(() => {
				const receipt = receiptFor(
					input.receipts,
					"goal.review",
					(entry) => entry.context?.reviewer === review.reviewer,
				);
				return receipt === undefined ? {} : { receipt };
			})(),
		}));
}

/** Check labels: did the verifier find this check met, given the worker's receipt? */
async function checkRows(input: {
	readonly run: string;
	readonly runDir: string;
	readonly leaves: readonly PlanLeaf[];
	readonly records: readonly ExecutionRecord[];
	readonly receipts: Map<string, Receipt[]>;
}): Promise<LabelRow[]> {
	const byId = new Map(input.leaves.map((leaf) => [leaf.id, leaf]));
	const rows: LabelRow[] = [];
	for (const record of input.records) {
		const leaf = byId.get(record.leaf_id);
		if (leaf === undefined) continue;
		const receiptPath = (await readdir(input.runDir).catch(() => []))
			.filter((name) => name.endsWith(`-leaf-${record.leaf_id}-receipt.md`))
			.map((name) => join(input.runDir, name))[0];
		const workerReceipt = receiptPath === undefined ? "" : await readFile(receiptPath, "utf8").catch(() => "");
		if (workerReceipt.trim().length === 0) continue;

		record.check_results.forEach((check, index) => {
			rows.push({
				run: input.run,
				surface: "goal.verify",
				question_key: `check_${index}`,
				kind: "noul",
				state: {
					task: leaf.task,
					owns: [...leaf.owns],
					checks: leaf.checks.map((entry) => ({ command: entry.command, expect: entry.expect })),
					worker_receipt: workerReceipt,
				},
				label: check.status === "passed",
				outcome: `verifier reported ${check.status}: ${check.evidence}`,
				has_receipt: input.receipts.has("goal.verify"),
				...(() => {
					const receipt = receiptFor(
						input.receipts,
						"goal.verify",
						(entry) => entry.context?.leaf_id === record.leaf_id && entry.question_key === `check_${index}`,
					);
					return receipt === undefined ? {} : { receipt };
				})(),
			});
		});
	}
	return rows;
}

/** Every label one run yields. */
export async function harvestRun(runDir: string, runName: string): Promise<LabelRow[]> {
	const names = await readdir(runDir).catch(() => [] as string[]);
	const ledger = await readJson<Ledger>(join(runDir, "goal-ledger.json"));
	if (ledger === undefined) return [];

	const receipts = await readReceipts(runDir);
	// The newest plan and report of the run: later turns supersede earlier ones,
	// and a leaf re-planned after a failure is a different contract.
	const planName = names
		.filter((name) => /^goal-execution-plan-turn-\d+\.json$/u.test(name))
		.sort()
		.at(-1);
	const reportName = names
		.filter((name) => /^turn-\d+-goal-execution-report\.json$/u.test(name))
		.sort()
		.at(-1);
	const plan = planName === undefined ? undefined : await readJson<{ leaves: PlanLeaf[] }>(join(runDir, planName));
	const report =
		reportName === undefined ? undefined : await readJson<{ records: ExecutionRecord[] }>(join(runDir, reportName));

	const leaves = plan?.leaves ?? [];
	const records = report?.records ?? [];
	return [
		...tierRows({ run: runName, leaves, records, receipts }),
		...reviewRows({ run: runName, ledger, receipts }),
		...(await checkRows({ run: runName, runDir, leaves, records, receipts })),
	];
}

export async function harvest(runsDir: string): Promise<LabelRow[]> {
	if (!existsSync(runsDir)) return [];
	const entries = await readdir(runsDir, { withFileTypes: true });
	const rows: LabelRow[] = [];
	for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
		rows.push(...(await harvestRun(join(runsDir, entry.name), entry.name)));
	}
	return rows;
}

function parseArgs(argv: readonly string[]): { runsDir: string; out?: string; quiet: boolean } {
	let runsDir = defaultRunsDir();
	let out: string | undefined;
	let quiet = false;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--quiet") {
			quiet = true;
			continue;
		}
		const value = argv[index + 1];
		if (flag === "--runs-dir" || flag === "--out") {
			if (!value) throw new Error(`${flag} needs a value`);
			if (flag === "--runs-dir") runsDir = value;
			else out = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${flag}`);
	}
	return { runsDir, out, quiet };
}

async function main(): Promise<void> {
	const { runsDir, out, quiet } = parseArgs(process.argv.slice(2));
	const rows = await harvest(runsDir);
	const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

	if (out === undefined) {
		process.stdout.write(rows.length === 0 ? "" : text);
	} else {
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, rows.length === 0 ? "" : text, "utf8");
	}

	if (!quiet) {
		const bySurface = new Map<string, number>();
		for (const row of rows) bySurface.set(row.surface, (bySurface.get(row.surface) ?? 0) + 1);
		const summary = [...bySurface].map(([surface, count]) => `${surface}=${count}`).join(" ");
		const withReceipts = rows.filter((row) => row.receipt !== undefined).length;
		console.error(
			rows.length === 0
				? `No labels found under ${runsDir}. Goal runs accumulate there as you use it.`
				: `${rows.length} label(s) from ${runsDir} (${summary}); ${withReceipts} joined to a System One receipt.`,
		);
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
