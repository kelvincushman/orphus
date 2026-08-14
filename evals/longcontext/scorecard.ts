/**
 * The shape of the long-context baseline scorecard, and how it is read back.
 *
 * The scorecard is committed so a later phase can cite a number rather than a
 * vibe. Most fields are measured directly; two are derived and say so in their
 * names — `sourceTokensEstimated` (⌈chars ÷ 4⌉, rounded up) and `ratio`
 * (bounded ÷ unbounded, to six decimal places). Nothing else is computed, so a
 * reader can treat every other field as an observation rather than an inference,
 * and can reproduce the two derived ones exactly.
 */

/**
 * Chars-to-tokens uses the repo's own conservative heuristic — see `estimateTokens`
 * in `compaction.ts`. Rounded up, so a partial token counts as a whole one.
 */
export const CHARS_PER_TOKEN = 4;

export function estimatedTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** One corpus size, measured both ways. */
export interface BoundaryMeasurement {
	/** Human label for the corpus, e.g. "260k". */
	readonly label: string;
	/** Characters in the source document. Measured. */
	readonly sourceChars: number;
	/** Estimated tokens in the source document. Derived from sourceChars. */
	readonly sourceTokensEstimated: number;
	/**
	 * Characters entering the parent's context when the result is returned whole
	 * — the paste-it-in baseline every later phase is trying to beat.
	 */
	readonly unboundedChars: number;
	/**
	 * Characters entering the parent's context once the runtime substitutes a
	 * reference. Measured through the real spill path, not a model of it.
	 */
	readonly boundedChars: number;
	/** boundedChars / unboundedChars, for readability. */
	readonly ratio: number;
	/**
	 * Whether the unbounded form fits the reference context window at all.
	 * `false` is a legitimate, expected result for the largest corpus: no model
	 * configured here has a 260k-token window, and recording that honestly is the
	 * point — it is the failure Phase 4 exists to beat, not an error.
	 */
	readonly unboundedFitsReferenceWindow: boolean;
}

export interface Scorecard {
	/** Bumped when the measurement method changes in a way that breaks comparison. */
	readonly schema: 1;
	/** Reference window used for the fits/does-not-fit column, in tokens. */
	readonly referenceWindowTokens: number;
	/** The runtime's spill threshold at the time of measurement, in characters. */
	readonly spillThresholdChars: number;
	readonly boundaries: readonly BoundaryMeasurement[];
	/**
	 * Model-backed task families are not part of this file. They need a
	 * subscription, are not reproducible run-to-run, and cannot run in CI — so
	 * they are recorded separately rather than mixed into numbers CI is allowed
	 * to gate on.
	 */
	readonly modelBacked: "not-run-here";
}

function isBoundaryMeasurement(value: unknown): value is BoundaryMeasurement {
	if (typeof value !== "object" || value === null) return false;
	const b = value as Partial<BoundaryMeasurement>;
	return (
		typeof b.label === "string" &&
		b.label.length > 0 &&
		typeof b.sourceChars === "number" &&
		typeof b.sourceTokensEstimated === "number" &&
		typeof b.unboundedChars === "number" &&
		typeof b.boundedChars === "number" &&
		typeof b.ratio === "number" &&
		typeof b.unboundedFitsReferenceWindow === "boolean"
	);
}

/**
 * A scorecard is only usable as a gate if it actually carries measurements.
 *
 * An empty `boundaries` array parses as valid JSON and would let `--check`
 * report success having compared nothing — the exact shape of a gate that looks
 * green while verifying nothing. So emptiness is rejected here, and every
 * boundary must be complete: a partially-written entry would otherwise silently
 * skip whichever corpus it belongs to.
 */
export function isScorecard(value: unknown): value is Scorecard {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Scorecard>;
	return (
		candidate.schema === 1 &&
		typeof candidate.referenceWindowTokens === "number" &&
		typeof candidate.spillThresholdChars === "number" &&
		candidate.modelBacked === "not-run-here" &&
		Array.isArray(candidate.boundaries) &&
		candidate.boundaries.length > 0 &&
		candidate.boundaries.every(isBoundaryMeasurement)
	);
}
