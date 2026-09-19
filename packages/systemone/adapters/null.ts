/**
 * The adapter that decides nothing.
 *
 * Every answer is maximally uncertain, so every decision abstains and every
 * call site falls through to the path it took before this layer existed. That
 * is the point: it is the default, and it is how the wiring gets proven. If a
 * single test changes behaviour with this adapter selected, the wiring is
 * wrong, not the model.
 */

import type { Questions, State, SystemOne } from "../port.ts";
import { uncertainAnswers } from "../schema.ts";

export const nullSystemOne: SystemOne = {
	id: "null@1",
	decide: async (_state: State, questions: Questions) => uncertainAnswers(questions),
};
