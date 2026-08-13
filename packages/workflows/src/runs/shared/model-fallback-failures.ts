/**
 * Compatibility exports for the shared Atomic model-failure classifier.
 *
 * The implementation lives in @orphus/coding-agent so the main chat, workflows,
 * and subagents cannot drift into separate fallback decisions.
 */

export type {
	ModelFallbackFailureKind,
	ModelFallbackFailureSignal,
	ModelFallbackFailureSource,
} from "@orphus/coding-agent";
export {
	errorMessage,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "@orphus/coding-agent";
