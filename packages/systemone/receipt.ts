/**
 * Receipts: what was asked, what came back, and whether it was acted on.
 *
 * Jev's decisions are inspectable through an external UI. Ours are inspectable
 * because every one of them lands next to the evidence it influenced, in the
 * run's own artifact directory. Abstentions are recorded too — a layer that
 * only logged the decisions it made would hide the times it was unsure, which
 * is exactly the number worth watching.
 *
 * `question_hash` exists for the improvement loop: a criteria wording is
 * revised over time, and an outcome can only be credited to the wording that
 * produced it if the wording is identified. Without it, the harvested labels
 * would mix generations of a question together.
 */

import { createHash } from "node:crypto";
import type { Answer, Decision, Question, State } from "./port.ts";

export interface SystemOneReceipt {
	/** Which call site asked, e.g. "goal.tier" or "goal.review". */
	readonly surface: string;
	readonly question_key: string;
	readonly kind: Question["type"];
	/** The answer in the shape that surface acts on: a boolean, a label, or a score. */
	readonly value: boolean | string | number;
	/** Probability of `value`. */
	readonly p: number;
	readonly confidence: number;
	readonly threshold: number;
	readonly abstain: boolean;
	readonly adapter_id: string;
	/** False until a calibration fitted on outcomes has been applied to this adapter. */
	readonly calibrated: boolean;
	readonly state_hash: string;
	readonly question_hash: string;
	readonly ts: string;
	/** Free-form identifiers for joining a receipt to what it judged, e.g. a leaf id. */
	readonly context?: Readonly<Record<string, string>>;
}

/**
 * Stable JSON: object keys sorted at every depth, so the same state hashes the
 * same however it was assembled. Same shape as `stableHash` in the workflows
 * executor; duplicated rather than imported because that module is not a
 * dependency of this package and a four-line function is not worth coupling.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(source)
				.sort()
				.map((key) => [key, canonicalize(source[key])]),
		);
	}
	return value;
}

function hash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)) ?? "")
		.digest("hex")
		.slice(0, 32);
}

/** Identifies the state a batch of questions was asked about. */
export function stateHash(state: State): string {
	return hash(state);
}

/** Identifies a question's exact wording and criteria, so answers can be grouped by version. */
export function questionHash(question: Question): string {
	return hash(question);
}

function answerValue(answer: Answer): { value: boolean | string | number; p: number } {
	if (answer.type === "noul") {
		const yes = answer.noul >= 0.5;
		return { value: yes, p: yes ? answer.noul : 1 - answer.noul };
	}
	if (answer.type === "choice") {
		return { value: answer.choice, p: answer.probabilities[answer.choice] ?? 0 };
	}
	const level = Math.round(answer.score);
	return { value: answer.score, p: answer.probabilities[level] ?? 0 };
}

export function receiptOf(input: {
	readonly surface: string;
	readonly questionKey: string;
	readonly question: Question;
	readonly decision: Decision;
	readonly threshold: number;
	readonly adapterId: string;
	readonly calibrated: boolean;
	readonly stateHash: string;
	readonly context?: Readonly<Record<string, string>>;
	readonly now?: () => Date;
}): SystemOneReceipt {
	const { value, p } = answerValue(input.decision.answer);
	return {
		surface: input.surface,
		question_key: input.questionKey,
		kind: input.question.type,
		value,
		p,
		confidence: input.decision.confidence,
		threshold: input.threshold,
		abstain: input.decision.abstain,
		adapter_id: input.adapterId,
		calibrated: input.calibrated,
		state_hash: input.stateHash,
		question_hash: questionHash(input.question),
		ts: (input.now?.() ?? new Date()).toISOString(),
		...(input.context === undefined ? {} : { context: input.context }),
	};
}

/**
 * Where receipts go. Deliberately narrow: Goal appends JSON Lines to the run's
 * artifact directory, tests collect in memory, and nothing else has to care.
 */
export interface ReceiptSink {
	record(receipts: readonly SystemOneReceipt[]): Promise<void>;
}

/** A sink that drops everything, for callers with no run directory to write to. */
export const nullReceiptSink: ReceiptSink = {
	record: async () => {},
};
