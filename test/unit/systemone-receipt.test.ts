import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { nullSystemOne } from "../../packages/systemone/adapters/null.ts";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "../../packages/systemone/port.ts";
import { decisionOf } from "../../packages/systemone/port.ts";
import { questionHash, receiptOf, stateHash } from "../../packages/systemone/receipt.ts";
import { answerFrom } from "../../packages/systemone/schema.ts";

const noul: NoulQuestion = { type: "noul", instructions: "Does the evidence satisfy the expectation?" };
const choice: ChoiceQuestion = { type: "choice", criteria: { fast: null, standard: null, judgment: null } };
const score: ScoreQuestion = { type: "score", criteria: ["mechanical", "ordinary", "architectural"] };

const receipt = (question: Parameters<typeof receiptOf>[0]["question"], weights: Record<string, number>) =>
	receiptOf({
		surface: "goal.test",
		questionKey: "key",
		question,
		decision: decisionOf(answerFrom(question, weights), 0.9),
		threshold: 0.9,
		adapterId: "null@1",
		calibrated: false,
		stateHash: stateHash("state"),
		now: () => new Date("2026-09-18T00:00:00.000Z"),
	});

describe("System One receipts", () => {
	test("records the yes/no answer with the probability of the value it reports", () => {
		const yes = receipt(noul, { true: 0.97, false: 0.03 });
		assert.equal(yes.value, true);
		assert.equal(yes.p, 0.97);
		assert.equal(yes.abstain, false);
		// A "no" reports the probability of NO, not the raw probability of yes:
		// a receipt reading `value: false, p: 0.02` would be unreadable.
		const no = receipt(noul, { true: 0.02, false: 0.98 });
		assert.equal(no.value, false);
		assert.equal(no.p, 0.98);
	});

	test("records abstentions, not only the decisions that were acted on", () => {
		const unsure = receipt(noul, { true: 0.55, false: 0.45 });
		assert.equal(unsure.abstain, true);
		assert.equal(unsure.threshold, 0.9);
	});

	test("records a choice and a score in the shape their surface acts on", () => {
		const picked = receipt(choice, { fast: 0.02, standard: 0.95, judgment: 0.03 });
		assert.equal(picked.value, "standard");
		assert.equal(picked.p, 0.95);
		assert.equal(picked.kind, "choice");
		const rated = receipt(score, { "0": 0.1, "1": 0.1, "2": 0.8 });
		assert.equal(rated.kind, "score");
		assert.equal(Math.round((rated.value as number) * 100) / 100, 1.7);
	});

	test("hashes state the same however the object was assembled", () => {
		assert.equal(stateHash({ a: 1, b: 2 }), stateHash({ b: 2, a: 1 }));
		assert.notEqual(stateHash({ a: 1 }), stateHash({ a: 2 }));
		assert.match(stateHash("anything"), /^[0-9a-f]{32}$/u);
	});

	test("hashes a question by its wording so a later revision is a different version", () => {
		// The improvement loop rewrites criteria; an outcome may only be credited
		// to the wording that produced it, so these must differ.
		const original = questionHash({ type: "noul", instructions: "Is this sufficient?" });
		const revised = questionHash({ type: "noul", instructions: "Is this sufficient evidence?" });
		assert.notEqual(original, revised);
		assert.equal(original, questionHash({ type: "noul", instructions: "Is this sufficient?" }));
	});

	test("carries the adapter identity and calibration status into the record", () => {
		const record = receipt(noul, { true: 0.97, false: 0.03 });
		assert.equal(record.adapter_id, "null@1");
		assert.equal(record.calibrated, false);
		assert.equal(record.ts, "2026-09-18T00:00:00.000Z");
	});
});

describe("the null adapter", () => {
	test("abstains on every question at any usable threshold", async () => {
		const answers = await nullSystemOne.decide("any state", { noul, choice, score });
		for (const [name, answer] of Object.entries(answers)) {
			assert.equal(decisionOf(answer, 0.01).abstain, true, name);
		}
	});

	test("still returns a well-formed answer for each question", async () => {
		const answers = await nullSystemOne.decide("any state", { noul, choice, score });
		assert.deepEqual(Object.keys(answers), ["noul", "choice", "score"]);
		assert.equal(answers.noul!.type, "noul");
		if (answers.noul!.type === "noul") assert.equal(answers.noul!.noul, 0.5);
		if (answers.score!.type === "score") assert.equal(answers.score!.score, 1);
	});
});
