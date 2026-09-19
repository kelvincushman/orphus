/**
 * The System One port: fixed questions in, typed decisions with probabilities out.
 *
 * The shapes below mirror TypeSafe's `/v1/systemone` wire schema (read from
 * `typesafe-sdk` 0.7.0's OpenAPI-generated models) rather than inventing a
 * parallel vocabulary. Two reasons, both practical: the `typesafe` adapter is
 * then a thin HTTP client instead of a translation layer, and a question
 * written for Orphus stays valid against Jev, so the two can answer the same
 * state and be compared.
 *
 * What a System One model is NOT: it generates no text. It scores the answers
 * the caller supplied. Everything here is therefore closed-vocabulary by
 * construction — a malformed answer is not possible, only an uncertain one.
 */

/** Text, or any JSON the caller would rather not flatten into a sentence. */
export type JsonContent = string | Record<string, unknown> | readonly unknown[];

/** A yes/no question. `criteria` says what each outcome means, when the wording alone is thin. */
export interface NoulQuestion {
	readonly type: "noul";
	readonly instructions?: JsonContent;
	readonly criteria?: {
		readonly true?: JsonContent;
		readonly false?: JsonContent;
	};
}

/**
 * Pick one label. `criteria` maps each label to a description of when it
 * applies; a `null` description means the label speaks for itself.
 */
export interface ChoiceQuestion {
	readonly type: "choice";
	readonly instructions?: JsonContent;
	readonly criteria: Readonly<Record<string, JsonContent | null>>;
}

/** Rate against an ordered rubric. Position is the score, counting from zero. */
export interface ScoreQuestion {
	readonly type: "score";
	readonly instructions?: JsonContent;
	readonly criteria: readonly JsonContent[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Questions keyed by the name their answer comes back under. */
export type Questions = Readonly<Record<string, Question>>;

/**
 * Probability that the answer is yes. There is deliberately no `confidence`
 * field: for a two-outcome question the probability already carries it, and
 * {@link noulConfidence} derives the one the abstain band uses.
 */
export interface NoulAnswer {
	readonly type: "noul";
	readonly noul: number;
}

export interface ChoiceAnswer {
	readonly type: "choice";
	readonly choice: string;
	readonly confidence: number;
	readonly probabilities: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
	readonly type: "score";
	/** Probability-weighted average of the levels, so it may fall between them. */
	readonly score: number;
	readonly confidence: number;
	readonly legend: Readonly<Record<number, JsonContent>>;
	readonly probabilities: Readonly<Record<number, number>>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Whatever the questions are about: a receipt, a diff, a leaf contract, a review record. */
export type State = JsonContent;

/**
 * An adapter. `id` names the adapter and its version and is recorded in every
 * receipt, so a decision can always be traced to what made it.
 *
 * `decide` never throws for an answer it could not obtain: an unreachable
 * backend, a malformed response or a timeout all resolve to maximally
 * uncertain answers, which the abstain band then routes to the LLM path. A
 * System One that fails must cost latency, never correctness.
 */
export interface SystemOne {
	readonly id: string;
	decide(state: State, questions: Questions): Promise<Record<string, Answer>>;
}

/** Jev's limits, enforced here so an Orphus question stays portable to it. */
export const MAX_CHOICE_LABELS = 255;
export const MAX_SCORE_LEVELS = 11;

export class SystemOneQuestionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SystemOneQuestionError";
	}
}

/**
 * Reject a question no backend could answer, at the call site that wrote it
 * rather than inside an adapter. The bounds are Jev's, not ours: exceeding
 * them would work locally and fail against the hosted model, which is the
 * kind of divergence that only shows up under comparison.
 */
export function assertValidQuestions(questions: Questions): void {
	const names = Object.keys(questions);
	if (names.length === 0) {
		throw new SystemOneQuestionError("At least one question is required.");
	}
	for (const name of names) {
		const question = questions[name]!;
		if (question.type === "choice") {
			const labels = Object.keys(question.criteria);
			if (labels.length === 0) {
				throw new SystemOneQuestionError(`Choice question "${name}" has no labels.`);
			}
			if (labels.length > MAX_CHOICE_LABELS) {
				throw new SystemOneQuestionError(
					`Choice question "${name}" has ${labels.length} labels; the limit is ${MAX_CHOICE_LABELS}.`,
				);
			}
		} else if (question.type === "score") {
			if (question.criteria.length === 0) {
				throw new SystemOneQuestionError(`Score question "${name}" has no levels; at least one is required.`);
			}
			if (question.criteria.length > MAX_SCORE_LEVELS) {
				throw new SystemOneQuestionError(
					`Score question "${name}" has ${question.criteria.length} levels; the limit is ${MAX_SCORE_LEVELS}.`,
				);
			}
		}
	}
}

/**
 * How far a yes/no answer sits from "no idea", on 0..1.
 *
 * This is the two-outcome case of {@link choiceConfidence}: with n=2 that
 * formula reduces to |2p-1|, so the abstain band means the same thing whether
 * a surface asked a noul or a two-label choice.
 */
export function noulConfidence(probabilityOfYes: number): number {
	return Math.abs(2 * probabilityOfYes - 1);
}

/** How far the winning label's probability sits above uniform, on 0..1. */
export function choiceConfidence(probabilities: readonly number[]): number {
	if (probabilities.length <= 1) return 1;
	const uniform = 1 / probabilities.length;
	return (Math.max(...probabilities) - uniform) / (1 - uniform);
}

/**
 * How tightly a score sits around its modal level, on 0..1.
 *
 * Ordered levels make spread meaningful in a way a flat maximum misses: a
 * distribution split between adjacent levels is a confident "about here",
 * while one split between the extremes is not, and both can share a peak.
 */
export function scoreConfidence(probabilities: readonly number[]): number {
	if (probabilities.length <= 1) return 1;
	const total = probabilities.reduce((sum, value) => sum + value, 0);
	const normalized =
		total === 0 ? probabilities.map(() => 1 / probabilities.length) : probabilities.map((value) => value / total);
	let modeIndex = 0;
	for (let index = 1; index < normalized.length; index += 1) {
		if (normalized[index]! > normalized[modeIndex]!) modeIndex = index;
	}
	const spread = normalized.reduce((sum, value, index) => sum + value * Math.abs(index - modeIndex), 0);
	const uniformCenter = (normalized.length - 1) / 2;
	const uniformSpread =
		normalized.reduce((sum, _value, index) => sum + Math.abs(index - uniformCenter), 0) / normalized.length;
	return Math.max(0, 1 - spread / uniformSpread);
}

/** The confidence of any answer, on the same 0..1 scale the thresholds use. */
export function answerConfidence(answer: Answer): number {
	return answer.type === "noul" ? noulConfidence(answer.noul) : answer.confidence;
}

/**
 * An answer plus the abstain verdict the caller acts on.
 *
 * `abstain` is Orphus policy, not part of any model's response: it is the whole
 * safety contract. Below the threshold the caller MUST take the System 2 path
 * it would have taken anyway, which is what makes this layer unable to make
 * Orphus wrong — only faster when it is sure.
 */
export interface Decision {
	readonly answer: Answer;
	readonly confidence: number;
	readonly abstain: boolean;
}

export function decisionOf(answer: Answer, threshold: number): Decision {
	const confidence = answerConfidence(answer);
	return { answer, confidence, abstain: confidence < threshold };
}

/** A confident yes/no, or `undefined` when the caller must fall through to System 2. */
export function confidentNoul(decision: Decision | undefined): boolean | undefined {
	if (decision === undefined || decision.abstain || decision.answer.type !== "noul") return undefined;
	return decision.answer.noul >= 0.5;
}

/** A confident label, or `undefined` when the caller must fall through to System 2. */
export function confidentChoice(decision: Decision | undefined): string | undefined {
	if (decision === undefined || decision.abstain || decision.answer.type !== "choice") return undefined;
	return decision.answer.choice;
}

/**
 * A confident level index, or `undefined`.
 *
 * The expected score is rounded because a caller picking a rubric level needs
 * one of the levels it declared, not the average of two.
 */
export function confidentScoreLevel(decision: Decision | undefined): number | undefined {
	if (decision === undefined || decision.abstain || decision.answer.type !== "score") return undefined;
	return Math.round(decision.answer.score);
}
