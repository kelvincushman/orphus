import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

/** One scripted model reply. Omitted fields get benign defaults. */
export interface ScriptedTurn {
	text?: string;
	toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
	stopReason?: AssistantMessage["stopReason"];
	/** Thrown instead of replying, to script a provider failure. */
	error?: string;
	/** HTTP status handed to `onResponse`. Defaults to 200, or 500 when `error` is set. */
	status?: number;
	usage?: Partial<Usage>;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ScriptedProvider {
	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): ReturnType<typeof createAssistantMessageEventStream>;
	/** The payload each dispatch delivered, in order — what the recorder saw. */
	readonly payloads: unknown[];
	/** Scripted turns not yet consumed. */
	readonly remaining: number;
}

/**
 * A provider that replies from a script.
 *
 * It calls `onPayload` and `onResponse` exactly where a real provider does, so
 * a replay exercises the real recording path rather than a stand-in for it. The
 * payload it reports is whatever `onPayload` returned — that is, the body after
 * hooks and sanitization, which is the body the recorder persists.
 */
export function createScriptedProvider(script: ScriptedTurn[], clock: { now(): number }): ScriptedProvider {
	const queue = [...script];
	const payloads: unknown[] = [];
	return {
		payloads,
		get remaining() {
			return queue.length;
		},
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const turn = queue.shift() ?? { text: "" };
			// A throw from onPayload — the recorder's fail-closed path — must end
			// the stream as an errored turn, exactly as a real provider surfaces a
			// pre-dispatch failure, not escape as an unhandled rejection.
			const run = async () => {
				const basePayload = { model: model.id, messages: context.messages };
				const finalPayload = (await options?.onPayload?.(basePayload, model)) ?? basePayload;
				payloads.push(finalPayload);
				const status = turn.status ?? (turn.error ? 500 : 200);
				await options?.onResponse?.({ status, headers: {} }, model);
				if (turn.error) {
					stream.end({
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: ZERO_USAGE,
						stopReason: "error",
						errorMessage: turn.error,
						timestamp: clock.now(),
					});
					return;
				}
				stream.end({
					role: "assistant",
					content: [
						...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
						...(turn.toolCalls ?? []).map((call) => ({
							type: "toolCall" as const,
							id: call.id,
							name: call.name,
							arguments: call.arguments,
						})),
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { ...ZERO_USAGE, ...turn.usage },
					stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "toolUse" : "stop"),
					timestamp: clock.now(),
				});
			};
			void run().catch((error) => {
				stream.end({
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: ZERO_USAGE,
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: clock.now(),
				});
			});
			return stream;
		},
	};
}
