import type {
	ModelFallbackFailureKind,
	ModelFallbackFailureSignal,
	ModelFallbackFailureSource,
} from "@orphus/coding-agent";
import {
	errorMessage,
	isRetryableModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "@orphus/coding-agent";
import {
	type ModelInfo as AvailableModelInfo,
	type ModelCostRates,
	splitKnownThinkingSuffix,
	THINKING_LEVELS,
} from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo, ModelFallbackFailureKind, ModelFallbackFailureSignal, ModelFallbackFailureSource };
export { errorMessage, isRetryableModelFailure, modelFailureMessage, normalizeModelFailureSignal };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	error?: string;
	usage?: Usage;
}

function applyFallbackThinkingLevel(model: string, thinkingLevel: string | undefined): string {
	if (!thinkingLevel || !THINKING_LEVELS.some((level) => level === thinkingLevel)) return model;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	return thinkingSuffix ? model : `${model}:${thinkingLevel}`;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	return applyFallbackThinkingLevel(model, thinking);
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

/**
 * One number per model so a ladder can be ordered. Agentic turns re-read their
 * context far more than they emit, so input is weighted 3:1 against output.
 * ponytail: fixed 3:1 blend; make the ratio a parameter when a caller measures a different mix.
 */
export function blendedCostPerMillion(cost: ModelCostRates): number {
	return (3 * cost.input + cost.output) / 4;
}

/**
 * The blended price of one ladder rung, or `undefined` when the registry does
 * not price it. The thinking suffix is stripped first: `anthropic/haiku:high`
 * and `anthropic/haiku` are the same model billed at the same rate, so a rung
 * that carries one must not sort as unpriced.
 */
function candidateCost(candidate: string, availableModels: AvailableModelInfo[] | undefined): number | undefined {
	const { baseModel } = splitKnownThinkingSuffix(candidate);
	const cost = availableModels?.find((entry) => entry.fullId === baseModel)?.cost;
	return cost ? blendedCostPerMillion(cost) : undefined;
}

/** Priced candidates cheapest-first; unpriced ones after them in declared order — unknown is not free. */
export function sortCandidatesByCost(candidates: string[], availableModels?: AvailableModelInfo[]): string[] {
	const rank = (candidate: string) => candidateCost(candidate, availableModels) ?? Number.POSITIVE_INFINITY;
	// Array.prototype.sort is stable, so equal and unpriced entries keep their declared order.
	return candidates
		.map((candidate) => ({ candidate, rank: rank(candidate) }))
		.sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1))
		.map((entry) => entry.candidate);
}

/**
 * Optional knobs for {@link buildModelCandidates}, kept as a trailing bag rather
 * than a seventh positional parameter so the six that precede it stay stable —
 * they are passed by position at four call sites.
 */
export interface ModelCandidateOptions {
	/**
	 * Walk the ladder cheapest-first instead of in declared order. The ladder
	 * still decides WHICH models are acceptable; this only moves where the
	 * failure-driven walk starts.
	 */
	cheapestFirst?: boolean;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	currentModel?: string,
	fallbackThinkingLevels?: string[],
	options: ModelCandidateOptions = {},
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const fallbackEntries = (fallbackModels ?? []).map((model, index) =>
		applyFallbackThinkingLevel(model, fallbackThinkingLevels?.[index]),
	);
	for (const raw of [primaryModel, ...fallbackEntries, currentModel]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return options.cheapestFirst ? sortCandidatesByCost(candidates, availableModels) : candidates;
}

export function currentModelFullId(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) return undefined;
	return `${String(model.provider)}/${model.id}`;
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || "model failure";
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
