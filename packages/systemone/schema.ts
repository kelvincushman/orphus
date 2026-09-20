/**
 * Turning raw per-label numbers into answers.
 *
 * Two adapters produce distributions rather than answers — the LLM wrapper
 * asks a model for them, the local adapter reads them off token logprobs — and
 * both then need the same three things: a schema to validate against, a
 * distribution that sums to 1, and the derived answer. All of that lives here
 * so the two adapters cannot drift apart in how they score the same numbers.
 */

import { type TSchema, Type } from "typebox";
import {
	type Answer,
	type ChoiceQuestion,
	choiceConfidence,
	type Question,
	type Questions,
	type ScoreQuestion,
	scoreConfidence,
} from "./port.ts";

/** The keys a distribution for this question must carry, in rubric order for a score. */
export function answerKeys(question: Question): readonly string[] {
	if (question.type === "noul") return ["true", "false"];
	if (question.type === "choice") return Object.keys(question.criteria);
	return question.criteria.map((_level, index) => String(index));
}

const probability = () => Type.Number({ minimum: 0, maximum: 1 });

/**
 * A TypeBox schema for one whole batch of answers: every question key present,
 * every label of every question present, each a probability.
 *
 * Asking for the full distribution rather than a single pick is what makes the
 * abstain band possible — a bare label carries no measure of how close the
 * runner-up was.
 */
export function answerSchemaFor(questions: Questions): TSchema {
	const properties: Record<string, TSchema> = {};
	for (const [name, question] of Object.entries(questions)) {
		const keys = answerKeys(question);
		const labelProperties: Record<string, TSchema> = {};
		for (const key of keys) labelProperties[key] = probability();
		properties[name] = Type.Object(labelProperties, { additionalProperties: false });
	}
	return Type.Object(properties, { additionalProperties: false });
}

/**
 * Rescale to sum to 1, falling back to uniform when every weight is zero.
 *
 * A model asked for probabilities routinely returns numbers that sum to 0.97
 * or 1.2. Renormalising is not cosmetic: the expected score and every
 * confidence figure below are only meaningful over a true distribution.
 */
export function normalizeDistribution(weights: Readonly<Record<string, number>>): Record<string, number> {
	const keys = Object.keys(weights);
	const total = keys.reduce((sum, key) => sum + Math.max(0, weights[key] ?? 0), 0);
	if (total <= 0) {
		const uniform = 1 / Math.max(1, keys.length);
		return Object.fromEntries(keys.map((key) => [key, uniform]));
	}
	return Object.fromEntries(keys.map((key) => [key, Math.max(0, weights[key] ?? 0) / total]));
}

function choiceAnswer(question: ChoiceQuestion, weights: Readonly<Record<string, number>>): Answer {
	const probabilities = normalizeDistribution(weights);
	const labels = Object.keys(question.criteria);
	let choice = labels[0] ?? "";
	for (const label of labels) {
		if ((probabilities[label] ?? 0) > (probabilities[choice] ?? 0)) choice = label;
	}
	return {
		type: "choice",
		choice,
		confidence: choiceConfidence(labels.map((label) => probabilities[label] ?? 0)),
		probabilities,
	};
}

function scoreAnswer(question: ScoreQuestion, weights: Readonly<Record<string, number>>): Answer {
	const probabilities = normalizeDistribution(weights);
	const ordered = question.criteria.map((_level, index) => probabilities[String(index)] ?? 0);
	return {
		type: "score",
		score: ordered.reduce((sum, value, index) => sum + index * value, 0),
		confidence: scoreConfidence(ordered),
		legend: Object.fromEntries(question.criteria.map((level, index) => [index, level])),
		probabilities: Object.fromEntries(ordered.map((value, index) => [index, value])),
	};
}

/** Build the answer for one question from its raw per-label weights. */
export function answerFrom(question: Question, weights: Readonly<Record<string, number>>): Answer {
	if (question.type === "noul") {
		const normalized = normalizeDistribution({ true: weights.true ?? 0, false: weights.false ?? 0 });
		return { type: "noul", noul: normalized.true ?? 0.5 };
	}
	return question.type === "choice" ? choiceAnswer(question, weights) : scoreAnswer(question, weights);
}

function isProbability(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Whether an answer built outside this package can be acted on.
 *
 * A matching `type` says nothing about the fields a decision is actually read
 * from. `decisionOf` compares the confidence against a threshold, and a missing
 * or non-numeric confidence compares `false` against every threshold — so an
 * answer that is merely malformed would be taken as a confident one. That is
 * the single way this layer can be wrong rather than slow, so the hosted
 * adapter checks the whole shape before letting an answer through.
 */
export function isWellFormedAnswer(question: Question, answer: Answer): boolean {
	if (question.type === "noul") return answer.type === "noul" && isProbability(answer.noul);
	if (question.type === "choice") {
		// A label nothing offered is as unusable as a missing confidence: the
		// caller would act on a choice that was never on the ballot.
		return (
			answer.type === "choice" &&
			isProbability(answer.confidence) &&
			typeof answer.choice === "string" &&
			Object.hasOwn(question.criteria, answer.choice)
		);
	}
	return (
		answer.type === "score" &&
		isProbability(answer.confidence) &&
		typeof answer.score === "number" &&
		Number.isFinite(answer.score) &&
		answer.score >= 0 &&
		answer.score <= question.criteria.length - 1
	);
}

/** The maximally uncertain answer: what every adapter returns when it could not decide. */
export function uncertainAnswer(question: Question): Answer {
	const keys = answerKeys(question);
	return answerFrom(question, Object.fromEntries(keys.map((key) => [key, 1])));
}

/** Uncertain answers for a whole batch, so a failed call abstains rather than throwing. */
export function uncertainAnswers(questions: Questions): Record<string, Answer> {
	return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, uncertainAnswer(question)]));
}
