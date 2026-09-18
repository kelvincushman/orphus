/**
 * @orphus/systemone — the decision layer that runs before the model.
 *
 * A deep module with one entrance: callers import the port and a factory, never
 * an adapter directly, so swapping what answers the questions never reaches a
 * call site. See README.md for the shape of the idea and
 * packages/coding-agent/docs/systemone.md for the user-facing account.
 */

export { nullSystemOne } from "./adapters/null.ts";
export {
	type Answer,
	answerConfidence,
	assertValidQuestions,
	type ChoiceAnswer,
	type ChoiceQuestion,
	choiceConfidence,
	confidentChoice,
	confidentNoul,
	confidentScoreLevel,
	type Decision,
	decisionOf,
	type JsonContent,
	MAX_CHOICE_LABELS,
	MAX_SCORE_LEVELS,
	type NoulAnswer,
	type NoulQuestion,
	noulConfidence,
	type Question,
	type Questions,
	type ScoreAnswer,
	type ScoreQuestion,
	type State,
	type SystemOne,
	SystemOneQuestionError,
	scoreConfidence,
} from "./port.ts";
export {
	nullReceiptSink,
	questionHash,
	type ReceiptSink,
	receiptOf,
	type SystemOneReceipt,
	stateHash,
} from "./receipt.ts";
export {
	answerFrom,
	answerKeys,
	answerSchemaFor,
	normalizeDistribution,
	uncertainAnswer,
	uncertainAnswers,
} from "./schema.ts";
