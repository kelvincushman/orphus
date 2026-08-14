import { boundedRender } from "@orphus/roundtable/bounded-render.ts";
import { type ChainStep, isDynamicParallelStep, isParallelStep, type SequentialStep } from "../../shared/settings.ts";
import type { ChainOutputMap, ChainOutputMapEntry, SingleResult } from "../../shared/types.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import {
	type DynamicFanoutConfig,
	DynamicFanoutError,
	hasDynamicFanoutFields,
	validateDynamicStepShape,
} from "./dynamic-fanout.ts";

const OUTPUT_REF_PATTERN = /\{outputs\.([^}]*)\}/g;
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * How much of a predecessor's output survives the splice.
 *
 * A chain step usually needs its predecessor's substance, not a taste of it, so
 * a single output is allowed a whole 2000 characters rather than the smaller
 * per-message share a room digest spreads across many messages. That matches
 * the room budget and is a real bound; `{outputs.name.full}` asks for everything.
 */
const CHAIN_SPLICE_TEXT_CAP = 2000;

/**
 * Budget must exceed the text cap, or the verbatim tier never fits.
 *
 * A verbatim line is the capped text *plus* the truncation marker and the path
 * to the full output. Budgeting exactly the cap makes that line one character
 * too long, silently demoting a 2000-character body to a ~100-character
 * headline — a much worse splice that still looks bounded. The headroom is what
 * keeps the useful tier reachable.
 */
const CHAIN_SPLICE_POINTER_HEADROOM = 400;

export class ChainOutputValidationError extends Error {}

interface ParsedOutputReference {
	name: string;
	/** `{outputs.name.full}` — the caller explicitly wants the whole text. */
	full: boolean;
}

/**
 * Parse `{outputs.name}` or `{outputs.name.full}`.
 *
 * Validation and resolution both go through this, so a reference that passes
 * the chain's up-front check cannot then be rejected at splice time — the two
 * would otherwise drift, and the failure would surface mid-run.
 */
function parseOutputReference(captured: string): ParsedOutputReference | undefined {
	const parts = captured.split(".");
	if (parts.length === 1) {
		return SAFE_OUTPUT_NAME_PATTERN.test(parts[0]!) ? { name: parts[0]!, full: false } : undefined;
	}
	if (parts.length === 2 && parts[1] === "full") {
		return SAFE_OUTPUT_NAME_PATTERN.test(parts[0]!) ? { name: parts[0]!, full: true } : undefined;
	}
	return undefined;
}

function outputNamesForStep(step: ChainStep): string[] {
	if (isParallelStep(step))
		return step.parallel.map((task) => task.as).filter((name): name is string => Boolean(name));
	if (isDynamicParallelStep(step)) return [step.collect.as];
	const name = (step as SequentialStep).as;
	return name ? [name] : [];
}

function taskTemplatesForStep(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((task) => task.task ?? "{previous}");
	if (isDynamicParallelStep(step))
		return [step.parallel.task ?? "{previous}", step.parallel.label ?? ""].filter(Boolean);
	return [(step as SequentialStep).task ?? "{previous}"];
}

export function validateChainOutputBindings(steps: ChainStep[], dynamicFanoutConfig: DynamicFanoutConfig = {}): void {
	const available = new Set<string>();
	const seen = new Set<string>();
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (hasDynamicFanoutFields(step)) {
			if (!isDynamicParallelStep(step)) {
				throw new ChainOutputValidationError(
					`Dynamic chain step ${stepIndex + 1} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`,
				);
			}
			try {
				validateDynamicStepShape(step, stepIndex, dynamicFanoutConfig);
			} catch (error) {
				if (error instanceof DynamicFanoutError) throw new ChainOutputValidationError(error.message);
				throw error;
			}
			if (!available.has(step.expand.from.output)) {
				throw new ChainOutputValidationError(
					`Dynamic chain step ${stepIndex + 1} references unknown output '${step.expand.from.output}'. Named outputs are only available after producing step/group completes.`,
				);
			}
		}
		for (const name of outputNamesForStep(step)) {
			if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
				throw new ChainOutputValidationError(
					`Invalid chain output name '${name}' at step ${stepIndex + 1}. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`,
				);
			}
			if (seen.has(name)) {
				throw new ChainOutputValidationError(`Duplicate chain output name '${name}'. Each as name must be unique.`);
			}
			seen.add(name);
		}
		for (const template of taskTemplatesForStep(step)) {
			for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
				const rawReference = match[0];
				const parsed = parseOutputReference(match[1]!);
				if (!parsed) {
					throw new ChainOutputValidationError(
						`Invalid chain output reference '${rawReference}' at step ${stepIndex + 1}. Use {outputs.name} for a bounded rendering plus a file path, or {outputs.name.full} for the complete text. Names match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
					);
				}
				const name = parsed.name;
				if (!available.has(name)) {
					throw new ChainOutputValidationError(
						`Unknown chain output reference '${rawReference}' at step ${stepIndex + 1}. Named outputs are only available after producing step/group completes.`,
					);
				}
			}
		}
		for (const name of outputNamesForStep(step)) {
			available.add(name);
		}
	}
}

/**
 * Splice a chain output into the next step's prompt.
 *
 * `{outputs.name}` was a full-text substitution: a step emitting 100 KB put
 * 100 KB into its successor's prompt, with nothing between the two. It now
 * splices a bounded rendering plus the path to the complete output, through the
 * same `boundedRender` core the room digest and parallel returns use.
 *
 * Two cases splice in full, deliberately. `{outputs.name.full}` is the caller
 * saying they need everything — the escape hatch that keeps this change from
 * breaking chains that genuinely depend on the whole text. And an entry with no
 * artifact path has nowhere to point, so bounding it would discard content
 * rather than relocate it; the same rule the parallel path follows.
 */
export function resolveOutputReferences(template: string, outputs: ChainOutputMap): string {
	return template.replace(OUTPUT_REF_PATTERN, (rawReference, captured: string) => {
		const parsed = parseOutputReference(captured);
		if (!parsed) {
			throw new ChainOutputValidationError(
				`Invalid chain output reference '${rawReference}'. Use {outputs.name} for a bounded rendering plus a file path, or {outputs.name.full} for the complete text. Names match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
			);
		}
		const entry = outputs[parsed.name];
		if (!entry) throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}'.`);
		if (parsed.full || !entry.artifactOutputPath) return entry.text;

		const rendered = boundedRender([entry], {
			budget: CHAIN_SPLICE_TEXT_CAP + CHAIN_SPLICE_POINTER_HEADROOM,
			perItemCap: CHAIN_SPLICE_TEXT_CAP,
			preserveOrder: true,
			format: {
				text: (item) => item.text,
				verbatim: (item, capped, truncated) =>
					truncated > 0 ? `${capped}\n…(+${truncated} chars) full output: ${item.artifactOutputPath}` : capped,
				headline: (item, capped) => `${capped} … full output: ${item.artifactOutputPath}`,
				collapsed: () => "",
			},
		});
		return rendered.text;
	});
}

function compactStructuredText(value: unknown): string {
	return JSON.stringify(value);
}

export function outputEntryFromResult(result: SingleResult, stepIndex: number): ChainOutputMapEntry {
	return {
		text:
			result.structuredOutput !== undefined
				? compactStructuredText(result.structuredOutput)
				: getSingleResultOutput(result),
		...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
		...(result.artifactPaths?.outputPath ? { artifactOutputPath: result.artifactPaths.outputPath } : {}),
		agent: result.agent,
		stepIndex,
	};
}

export function outputEntryFromAsyncResult(
	result: { agent: string; output: string; structuredOutput?: unknown },
	stepIndex: number,
): ChainOutputMapEntry {
	return {
		text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : result.output,
		...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
		agent: result.agent,
		stepIndex,
	};
}
