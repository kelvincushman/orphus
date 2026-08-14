/**
 * The shape of the long-context baseline scorecard, and how it is read back.
 *
 * The scorecard is committed so a later phase can cite a number rather than a
 * vibe. It is deliberately plain JSON with no derived fields: every figure is
 * measured, and anything estimated says so in its name.
 */

/** Chars-to-tokens uses the repo's own conservative heuristic — see `estimateTokens` in `compaction.ts`. */
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

export function isScorecard(value: unknown): value is Scorecard {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Scorecard>;
	return (
		candidate.schema === 1 &&
		typeof candidate.referenceWindowTokens === "number" &&
		Array.isArray(candidate.boundaries)
	);
}
