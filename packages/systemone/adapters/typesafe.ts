/**
 * TypeSafe's hosted System One model, as a yardstick.
 *
 * This exists to answer one question honestly: how far is the local adapter
 * from a model trained for this job? Because the port mirrors TypeSafe's wire
 * shape, the same state and the same questions go to both, and the receipts
 * they produce share a `state_hash` — so the comparison is a diff, not an
 * argument.
 *
 * It is never on a default path. It runs only when the adapter is named
 * explicitly and an API key is present in the environment, and the key is read
 * from the environment alone: a hosted credential does not belong in a config
 * file that gets committed.
 */

import type { Answer, Questions, State, SystemOne } from "../port.ts";
import { uncertainAnswers } from "../schema.ts";

export interface TypesafeSystemOneOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly timeoutMs?: number;
	readonly id?: string;
	readonly fetch?: typeof globalThis.fetch;
}

/** The wire shape of `POST /v1/systemone`, as the published SDK defines it. */
interface WireResponse {
	readonly model?: string;
	readonly answers?: Record<string, Answer>;
}

/**
 * Accept only the answers that match the questions asked.
 *
 * A response naming a question we did not ask, or answering one with the wrong
 * primitive, is a version skew rather than a decision — and the safe reading of
 * a decision we cannot interpret is that there was none.
 */
function reconcile(questions: Questions, answers: Record<string, Answer> | undefined): Record<string, Answer> {
	const fallback = uncertainAnswers(questions);
	if (answers === undefined) return fallback;
	const result: Record<string, Answer> = {};
	for (const [name, question] of Object.entries(questions)) {
		const answer = answers[name];
		result[name] = answer !== undefined && answer.type === question.type ? answer : fallback[name]!;
	}
	return result;
}

export function createTypesafeSystemOne(options: TypesafeSystemOneOptions): SystemOne {
	const baseUrl = (options.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/u, "");
	const model = options.model ?? "jev-latest";
	const timeoutMs = options.timeoutMs ?? 10_000;
	const doFetch = options.fetch ?? globalThis.fetch;

	return {
		id: options.id ?? `typesafe:${model}`,
		decide: async (state: State, questions: Questions) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await doFetch(`${baseUrl}/v1/systemone`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
						authorization: `Bearer ${options.apiKey}`,
					},
					body: JSON.stringify({ model, state, questions }),
					signal: controller.signal,
				});
				if (!response.ok) {
					return uncertainAnswers(questions);
				}
				return reconcile(questions, ((await response.json()) as WireResponse).answers);
			} catch {
				// Rate limited, unreachable, or slow: abstain, exactly as every
				// other adapter does. A hosted dependency must not be able to fail
				// a run that would otherwise have proceeded without it.
				return uncertainAnswers(questions);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
