import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "../../packages/systemone/port.ts";
import {
	answerConfidence,
	assertValidQuestions,
	choiceConfidence,
	confidentChoice,
	confidentNoul,
	confidentScoreLevel,
	decisionOf,
	MAX_CHOICE_LABELS,
	MAX_SCORE_LEVELS,
	noulConfidence,
	SystemOneQuestionError,
	scoreConfidence,
} from "../../packages/systemone/port.ts";
import { answerFrom, answerKeys, answerSchemaFor, normalizeDistribution } from "../../packages/systemone/schema.ts";

const noul: NoulQuestion = { type: "noul", instructions: "Is this evidence sufficient?" };
const choice: ChoiceQuestion = {
	type: "choice",
	instructions: "Which reviewer profile fits?",
	criteria: { fast: "mechanical", standard: "ordinary", judgment: "risky" },
};
const score: ScoreQuestion = {
	type: "score",
	instructions: "How much reasoning is required?",
	criteria: ["mechanical", "ordinary", "architectural"],
};

describe("System One question validation", () => {
	test("rejects an empty batch", () => {
		assert.throws(() => assertValidQuestions({}), SystemOneQuestionError);
	});

	test("accepts questions inside Jev's limits", () => {
		assertValidQuestions({ noul, choice, score });
	});

	test("rejects a choice beyond 255 labels so the question stays portable to Jev", () => {
		const criteria = Object.fromEntries(
			Array.from({ length: MAX_CHOICE_LABELS + 1 }, (_value, index) => [`label-${index}`, null]),
		);
		assert.throws(() => assertValidQuestions({ tooMany: { type: "choice", criteria } }), /limit is 255/u);
	});

	test("rejects a score beyond 11 levels and an empty rubric", () => {
		const criteria = Array.from({ length: MAX_SCORE_LEVELS + 1 }, (_value, index) => `level ${index}`);
		assert.throws(() => assertValidQuestions({ deep: { type: "score", criteria } }), /limit is 11/u);
		assert.throws(() => assertValidQuestions({ empty: { type: "score", criteria: [] } }), /at least one/u);
		assert.throws(() => assertValidQuestions({ none: { type: "choice", criteria: {} } }), /no labels/u);
	});
});

describe("System One confidence", () => {
	test("a yes/no answer is confident exactly as far as it is from a coin flip", () => {
		assert.equal(noulConfidence(0.5), 0);
		assert.equal(noulConfidence(1), 1);
		assert.equal(noulConfidence(0), 1);
		assert.equal(Math.round(noulConfidence(0.9) * 100) / 100, 0.8);
	});

	test("noul confidence is the two-label case of choice confidence", () => {
		// The abstain band has to mean the same thing whichever primitive a
		// surface happened to use, so these must not be two different scales.
		for (const p of [0.5, 0.6, 0.75, 0.9, 1]) {
			assert.equal(Math.round(noulConfidence(p) * 1e6), Math.round(choiceConfidence([p, 1 - p]) * 1e6), `p=${p}`);
		}
	});

	test("a uniform distribution has zero confidence and a certain one has full", () => {
		assert.equal(choiceConfidence([1 / 3, 1 / 3, 1 / 3]), 0);
		assert.equal(choiceConfidence([1, 0, 0]), 1);
		assert.equal(scoreConfidence([1 / 3, 1 / 3, 1 / 3]), 0);
		assert.equal(scoreConfidence([0, 1, 0]), 1);
	});

	test("a score split between adjacent levels beats one split between the extremes", () => {
		// Both peak at the same height; only the ordered spread tells them apart,
		// which is the whole reason score has its own confidence measure.
		const adjacent = scoreConfidence([0.5, 0.5, 0]);
		const extremes = scoreConfidence([0.5, 0, 0.5]);
		assert.ok(adjacent > extremes, `${adjacent} should exceed ${extremes}`);
	});

	test("a single-option question is trivially certain", () => {
		assert.equal(choiceConfidence([1]), 1);
		assert.equal(scoreConfidence([1]), 1);
	});
});

describe("System One decisions", () => {
	test("abstains below the threshold and commits above it", () => {
		const answer = answerFrom(noul, { true: 0.9, false: 0.1 });
		assert.equal(decisionOf(answer, 0.5).abstain, false);
		assert.equal(decisionOf(answer, 0.9).abstain, true);
		assert.equal(answerConfidence(answer), noulConfidence(0.9));
	});

	test("an abstaining decision yields no value to act on", () => {
		const unsure = decisionOf(answerFrom(noul, { true: 0.55, false: 0.45 }), 0.9);
		assert.equal(confidentNoul(unsure), undefined);
		assert.equal(confidentNoul(undefined), undefined);
		assert.equal(
			confidentChoice(decisionOf(answerFrom(choice, { fast: 1, standard: 1, judgment: 1 }), 0.8)),
			undefined,
		);
	});

	test("a confident decision yields the value its surface acts on", () => {
		assert.equal(confidentNoul(decisionOf(answerFrom(noul, { true: 0.97, false: 0.03 }), 0.8)), true);
		assert.equal(confidentNoul(decisionOf(answerFrom(noul, { true: 0.02, false: 0.98 }), 0.8)), false);
		assert.equal(
			confidentChoice(decisionOf(answerFrom(choice, { fast: 0.02, standard: 0.95, judgment: 0.03 }), 0.8)),
			"standard",
		);
		assert.equal(confidentScoreLevel(decisionOf(answerFrom(score, { "0": 0.02, "1": 0.02, "2": 0.96 }), 0.8)), 2);
	});

	test("asking a confident answer for the wrong primitive yields nothing", () => {
		const confident = decisionOf(answerFrom(choice, { fast: 0.95, standard: 0.03, judgment: 0.02 }), 0.5);
		assert.equal(confidentNoul(confident), undefined);
		assert.equal(confidentScoreLevel(confident), undefined);
	});
});

describe("System One answer derivation", () => {
	test("normalizes a distribution that does not sum to one", () => {
		const normalized = normalizeDistribution({ a: 0.6, b: 0.6 });
		assert.equal(normalized.a, 0.5);
		assert.equal(normalized.b, 0.5);
	});

	test("falls back to uniform rather than dividing by zero", () => {
		const normalized = normalizeDistribution({ a: 0, b: 0, c: 0 });
		assert.deepEqual(Object.values(normalized), [1 / 3, 1 / 3, 1 / 3]);
	});

	test("treats a negative weight as zero", () => {
		const normalized = normalizeDistribution({ a: -1, b: 1 });
		assert.equal(normalized.a, 0);
		assert.equal(normalized.b, 1);
	});

	test("a score is the probability-weighted average of its levels", () => {
		const answer = answerFrom(score, { "0": 0.1, "1": 0.1, "2": 0.8 });
		assert.equal(answer.type, "score");
		if (answer.type !== "score") return;
		assert.equal(Math.round(answer.score * 100) / 100, 1.7);
		assert.deepEqual(answer.legend, { 0: "mechanical", 1: "ordinary", 2: "architectural" });
	});

	test("answer keys follow the question's own vocabulary", () => {
		assert.deepEqual(answerKeys(noul), ["true", "false"]);
		assert.deepEqual(answerKeys(choice), ["fast", "standard", "judgment"]);
		assert.deepEqual(answerKeys(score), ["0", "1", "2"]);
	});

	test("the derived schema names every question and every label", () => {
		const schema = answerSchemaFor({ noul, choice, score }) as {
			properties: Record<string, { properties: Record<string, unknown> }>;
		};
		assert.deepEqual(Object.keys(schema.properties), ["noul", "choice", "score"]);
		assert.deepEqual(Object.keys(schema.properties.choice!.properties), ["fast", "standard", "judgment"]);
		assert.deepEqual(Object.keys(schema.properties.score!.properties), ["0", "1", "2"]);
	});
});
