/**
 * The long-context baseline: what an oversized tool result actually costs the
 * parent's context window, measured through the runtime rather than modelled.
 *
 * WP 0.1 of the RLM adoption plan. Every later phase is judged on whether parent
 * context shrank, so this establishes the number those phases cite. It runs
 * against the working tree — that is the whole point, and it is why this does
 * not live in `evals/`'s Pier/Harbor adapter, which installs the agent from npm
 * inside Docker and therefore measures a published build rather than your
 * changes.
 *
 * Two tiers exist and they are kept apart on purpose:
 *
 *   - this file is **deterministic**: no model, no network, no subscription. The
 *     same input always produces the same number, so CI may gate on it.
 *   - the model-backed task families (aggregate Q&A, repo comprehension, fleet
 *     deliberation) need a subscription and are not reproducible run-to-run.
 *     Mixing them in here would make a number CI gates on depend on a model's
 *     mood. They are recorded separately.
 *
 * Run with `npm run evals:baseline`. It fails rather than reports: a regression
 * against the committed scorecard exits non-zero.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextAccounting, formatChars } from "../../packages/coding-agent/src/core/context-accounting.js";
import { PERSISTED_OUTPUT_TAG } from "../../packages/coding-agent/src/core/tools/tool-limits.js";
import {
	collectText,
	getPersistenceThreshold,
	redirectOversizedToolResult,
} from "../../packages/coding-agent/src/core/tools/oversized-tool-result.js";
import { type BoundaryMeasurement, estimatedTokens, isScorecard, type Scorecard } from "./scorecard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCORECARD_PATH = join(HERE, "scorecard.json");

/**
 * The corpus sizes the plan asks for. They are token targets; the generator
 * converts them to characters with the same heuristic the runtime uses, so a
 * "260k" corpus is 260k tokens by the same measure the runtime would apply.
 */
const CORPUS_TOKENS = [
	{ label: "50k", tokens: 50_000 },
	{ label: "130k", tokens: 130_000 },
	{ label: "260k", tokens: 260_000 },
] as const;

/**
 * A context window to report fits/does-not-fit against. 200k is the common
 * large-model figure; the 260k corpus is expected to exceed it, and that
 * expectation is the finding rather than a failure.
 */
const REFERENCE_WINDOW_TOKENS = 200_000;

/**
 * The bounded path must stay under this no matter how large the input grows.
 * The spill replacement is a preview plus a path, so this is generous — the
 * assertion is about the *shape* of the curve (flat), not the constant.
 */
const BOUNDED_CEILING_CHARS = 10_000;

/**
 * Build a document of roughly the requested token size. Prose-shaped rather
 * than a repeated character: a run of one byte would compress and truncate
 * differently from real text, and the number would flatter us.
 */
function buildCorpus(tokens: number): string {
	const target = tokens * 4;
	const paragraph =
		"The broker holds room state in a ring buffer keyed by sequence number, and the digest " +
		"spends its budget newest-first so conclusions survive while early exploration collapses " +
		"to headlines. A late joiner therefore pays for the shape of the discussion rather than " +
		"its length, which is the property the context-window contract exists to guarantee. ";
	const out: string[] = [];
	let length = 0;
	for (let i = 0; length < target; i++) {
		const line = `[${i}] ${paragraph}`;
		out.push(line);
		length += line.length;
	}
	return out.join("\n").slice(0, target);
}

async function measure(label: string, tokens: number): Promise<BoundaryMeasurement> {
	const text = buildCorpus(tokens);
	const result = { content: [{ type: "text" as const, text }], details: undefined };
	const sourceChars = collectText(result.content).length;

	// The real spill path, with a real session directory, not a reimplementation.
	const replacement = await redirectOversizedToolResult({
		toolName: "read",
		toolCallId: `baseline-${label}`,
		result,
		isError: false,
		sessionId: "evals-longcontext-baseline",
	});

	const boundedText = collectText(replacement?.content ?? result.content);
	const boundedChars = boundedText.length;

	// A bound is only honoured if what replaces the payload still tells the model
	// how to get the rest. Assert the substitution carries both halves of that
	// contract — the marker and a real path — rather than inferring it from the
	// length, which would also pass for a truncated stub.
	if (replacement) {
		if (!boundedText.includes(PERSISTED_OUTPUT_TAG)) {
			console.error(`\nFAIL: the ${label} replacement is missing the ${PERSISTED_OUTPUT_TAG} marker.`);
			process.exit(1);
		}
		const savedPath = /Full output saved to: (\S+)/.exec(boundedText)?.[1];
		if (!savedPath || !existsSync(savedPath)) {
			console.error(
				`\nFAIL: the ${label} replacement points at ${savedPath ?? "no file"}, which does not exist. ` +
					"The pointer is the only way back to the content it replaced.",
			);
			process.exit(1);
		}
	}

	// Route both through the same accounting the runtime uses, so the eval and
	// the footer can never disagree about what a result cost.
	const accounting = new ContextAccounting();
	accounting.record({
		toolName: "read",
		chars: boundedChars,
		originalChars: sourceChars,
		spilled: replacement !== undefined,
	});
	const totals = accounting.totals();

	return {
		label,
		sourceChars,
		sourceTokensEstimated: estimatedTokens(sourceChars),
		unboundedChars: totals.originalChars,
		boundedChars: totals.chars,
		ratio: Number((totals.chars / totals.originalChars).toFixed(6)),
		unboundedFitsReferenceWindow: estimatedTokens(sourceChars) <= REFERENCE_WINDOW_TOKENS,
	};
}

function readCommitted(): Scorecard | undefined {
	if (!existsSync(SCORECARD_PATH)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(SCORECARD_PATH, "utf-8"));
		return isScorecard(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function report(scorecard: Scorecard): void {
	console.log("\nLong-context baseline — what an oversized tool result costs the parent context\n");
	console.log(
		`  ${"corpus".padEnd(8)}${"source".padStart(12)}${"unbounded".padStart(12)}${"bounded".padStart(10)}${"ratio".padStart(10)}   fits ${REFERENCE_WINDOW_TOKENS / 1000}k window`,
	);
	for (const b of scorecard.boundaries) {
		console.log(
			`  ${b.label.padEnd(8)}${formatChars(b.sourceChars).padStart(12)}${formatChars(b.unboundedChars).padStart(12)}` +
				`${formatChars(b.boundedChars).padStart(10)}${`${(b.ratio * 100).toFixed(3)}%`.padStart(10)}   ` +
				(b.unboundedFitsReferenceWindow ? "yes" : "NO — pasting it in is not an option"),
		);
	}
}

async function main(): Promise<void> {
	const boundaries: BoundaryMeasurement[] = [];
	for (const { label, tokens } of CORPUS_TOKENS) {
		boundaries.push(await measure(label, tokens));
	}

	const scorecard: Scorecard = {
		schema: 1,
		referenceWindowTokens: REFERENCE_WINDOW_TOKENS,
		spillThresholdChars: getPersistenceThreshold(),
		boundaries,
		modelBacked: "not-run-here",
	};

	report(scorecard);

	// --- assertions: this fails rather than merely reporting -----------------

	for (const b of boundaries) {
		if (b.boundedChars > BOUNDED_CEILING_CHARS) {
			console.error(
				`\nFAIL: the ${b.label} corpus put ${formatChars(b.boundedChars)} into context, ` +
					`above the ${formatChars(BOUNDED_CEILING_CHARS)} ceiling. The bound is supposed to be flat in input size.`,
			);
			process.exit(1);
		}
	}

	// The curve must be flat, not merely small: a bound that grows with input is
	// truncation wearing a bound's clothes.
	const smallest = boundaries[0];
	const largest = boundaries[boundaries.length - 1];
	if (smallest && largest && largest.boundedChars > smallest.boundedChars * 1.5) {
		console.error(
			`\nFAIL: bounded cost grew from ${formatChars(smallest.boundedChars)} to ${formatChars(largest.boundedChars)} ` +
				`as input grew ${(largest.sourceChars / smallest.sourceChars).toFixed(1)}x. That is truncation, not a bound.`,
		);
		process.exit(1);
	}

	// `--check` verifies without rewriting: CI compares against the committed
	// scorecard and must not mutate it. Updating the baseline is a deliberate
	// local act that gets committed like any other change.
	const checkOnly = process.argv.includes("--check");

	const committed = readCommitted();
	if (committed) {
		// A committed scorecard missing a corpus would skip that comparison
		// silently, so absence is a failure rather than a shrug. Adding a corpus
		// is a deliberate act: run without --check to record it.
		const missing = boundaries.filter((b) => !committed.boundaries.some((p) => p.label === b.label)).map((b) => b.label);
		if (missing.length > 0) {
			console.error(
				`\nFAIL: the committed scorecard has no entry for ${missing.join(", ")}, so those corpora ` +
					"would go uncompared. Re-run without --check to record them deliberately.",
			);
			process.exit(1);
		}
		for (const b of boundaries) {
			const previous = committed.boundaries.find((p) => p.label === b.label);
			if (!previous) continue;
			if (b.boundedChars > previous.boundedChars) {
				console.error(
					`\nFAIL: ${b.label} regressed — ${formatChars(previous.boundedChars)} committed, ` +
						`${formatChars(b.boundedChars)} now. Parent context got more expensive.`,
				);
				process.exit(1);
			}
		}
		console.log("\nNo regression against the committed scorecard.");
	} else if (checkOnly) {
		console.error("\nFAIL: --check requires a committed scorecard, and none was readable.");
		process.exit(1);
	} else {
		console.log("\nNo committed scorecard yet — writing the first one.");
	}

	if (checkOnly) {
		console.log("Checked without rewriting the scorecard.");
	} else {
		writeFileSync(SCORECARD_PATH, `${JSON.stringify(scorecard, null, "\t")}\n`, "utf-8");
		console.log(`Scorecard written to ${SCORECARD_PATH}`);
	}
	console.log(
		"\nModel-backed task families are not measured here: they need a subscription, do not\n" +
			"reproduce run-to-run, and must not become something CI gates on.",
	);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
