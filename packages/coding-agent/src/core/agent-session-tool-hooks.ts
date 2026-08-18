import type { PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { assertToolPairingInvariant } from "./context-tool-pairing.js";
import {
	applyValidatedArguments,
	buildToolAuditRecord,
	revalidateToolArguments,
	TOOL_AUDIT_ENTRY,
	type ToolAuditOutcome,
} from "./tool-audit.ts";
import { collectText, redirectOversizedToolResult } from "./tools/oversized-tool-result.js";

/**
 * Append `orphus.tool.audit.v1`. Observation must never take the tool down, so a
 * write failure is swallowed — unlike the provider request record, whose absence
 * makes a dispatch unreplayable and therefore fails the attempt.
 */
export function _recordToolAudit(
	this: AgentSession,
	input: {
		toolCallId: string;
		toolName: string;
		outcome: ToolAuditOutcome;
		argumentsBefore: unknown;
		argumentsAfter: unknown;
		reason?: string;
	},
): void {
	try {
		this.sessionManager.appendCustomEntry(
			TOOL_AUDIT_ENTRY,
			buildToolAuditRecord({ ...input, timestamp: this._capabilities.clock.now() }),
		);
	} catch {
		// Intentionally ignored — see the doc comment.
	}
}

export function _installAgentToolHooks(this: AgentSession): void {
	// resolve → initial schema validation (both upstream in the agent loop) →
	// mutable hooks → snapshot → schema revalidation → policy/approval → execute.
	// Everything from the snapshot onwards lives here.
	this.agent.beforeToolCall = async ({ toolCall, args }) => {
		const runner = this._extensionRunner;
		const argumentsBefore = structuredClone(args);
		let hookResult: Awaited<ReturnType<typeof runner.emitToolCall>>;

		if (runner.hasHandlers("tool_call")) {
			await this._agentEventQueue;
			try {
				hookResult = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}

		// Snapshot, then revalidate what the hooks left behind. Policy and the
		// tool itself must both see these arguments and no earlier version.
		const revalidation = revalidateToolArguments(this.getToolDefinition(toolCall.name), args);
		if (!revalidation.ok) {
			this._recordToolAudit({
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				outcome: "invalid_arguments",
				argumentsBefore,
				argumentsAfter: args,
				reason: revalidation.reason,
			});
			return { block: true, reason: revalidation.reason };
		}
		applyValidatedArguments(args, revalidation.args);

		this._recordToolAudit({
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			outcome: hookResult?.block ? "blocked" : "executed",
			argumentsBefore,
			argumentsAfter: args,
			reason: hookResult?.block ? hookResult.reason : undefined,
		});
		return hookResult;
	};

	this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				})
			: undefined;

		const extensionReplacement = hookResult
			? {
					content: hookResult.content,
					details: hookResult.details,
					isError: hookResult.isError ?? isError,
				}
			: undefined;
		const finalResult = hookResult
			? {
					content: hookResult.content ?? result.content,
					// Preserve original details when an extension hook rewrites only content;
					// the redirect check only replaces model-visible content blocks.
					details: hookResult.details ?? result.details,
				}
			: result;
		const finalIsError = hookResult?.isError ?? isError;
		const redirectReplacement = await redirectOversizedToolResult({
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			result: finalResult,
			isError: finalIsError,
			sessionId: this.sessionManager.getSessionId(),
			sessionDir: this.sessionManager.getSessionDir() || undefined,
			maxResultSizeChars: this.getToolDefinition(toolCall.name)?.maxResultSizeChars,
		});

		// Context accounting. This hook is the single door every tool result passes
		// through on its way into the model's context, and the only place that knows
		// both what the result held and whether a spill reference replaced it.
		// An extension replacement with undefined content leaves the original
		// standing, which finalResult.content has already resolved — so the only
		// substitution that changes what the model sees is the spill.
		const originalChars = collectText(finalResult.content).length;
		this._contextAccounting.record({
			toolName: toolCall.name,
			chars: collectText(redirectReplacement?.content ?? finalResult.content).length,
			originalChars,
			spilled: redirectReplacement !== undefined,
		});

		if (result.terminate === true) this._terminatingToolCallIds.add(toolCall.id);
		else this._terminatingToolCallIds.delete(toolCall.id);
		return redirectReplacement ?? extensionReplacement;
	};
}

/**
 * Install a prepareNextTurnWithContext hook so that extension tool changes
 * (e.g. setActiveTools) and before_agent_start systemPrompt overrides are
 * applied to the next provider request within the same run.
 */
export function _installAgentNextTurnRefresh(this: AgentSession): void {
	const previousPrepareNextTurnWithContext =
		this.agent.prepareNextTurnWithContext ??
		(this.agent.prepareNextTurn
			? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
			: undefined);
	const previousTransformContext = this.agent.transformContext;
	this.agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const guarded = this._finishPostToolCompactionPreflight(transformed);
		// Last checkpoint before provider conversion: a structurally invalid context
		// here becomes an unrecoverable provider 400, so surface it as an Orphus error.
		assertToolPairingInvariant(guarded);
		return guarded;
	};
	this.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
		const previousContext = previousSnapshot?.context ?? turn.context;
		const toolCallIds = turn.message.content.filter((part) => part.type === "toolCall").map((part) => part.id);
		const terminatingBatch =
			toolCallIds.length > 0 && toolCallIds.every((id) => this._terminatingToolCallIds.has(id));
		for (const id of toolCallIds) this._terminatingToolCallIds.delete(id);
		const messages =
			turn.toolResults.length > 0 && !terminatingBatch
				? await this._preflightPostToolContext(previousContext.messages, signal)
				: previousContext.messages;

		// Restore before queued follow-up messages are polled, but keep the
		// fallback for deceptive completions that event processing must retry on
		// the same model (safety refusal, empty completion, or length truncation).
		const preserveFallbackForFailure =
			turn.message.role === "assistant" &&
			!this.agent.hasQueuedMessages() &&
			(turn.message.stopReason === "length" ||
				this._isEmptyCompletion?.(turn.message) === true ||
				this._isSafetyRefusal?.(turn.message) === true);
		if (!preserveFallbackForFailure && (turn.toolResults.length === 0 || terminatingBatch)) {
			await this._agentEventQueue;
			await this._restoreFallbackModel();
		}

		return {
			...previousSnapshot,
			context: {
				...previousContext,
				messages,
				systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
				tools: this.agent.state.tools.slice(),
			},
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	};
}

export const agentSessionToolHooksMethods = {
	_installAgentToolHooks,
	_installAgentNextTurnRefresh,
	_recordToolAudit,
};
