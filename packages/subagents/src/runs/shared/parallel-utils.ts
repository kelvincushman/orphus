import type { CodexFastModeResolvedSettings, CodexFastModeScope } from "@orphus/coding-agent";
import { boundedRender } from "@orphus/roundtable/bounded-render.ts";
import type { ModelAttempt } from "../../shared/types.ts";

export interface RunnerSubagentStep {
	agent: string;
	task: string;
	phase?: string;
	label?: string;
	outputName?: string;
	structured?: boolean;
	intercomGroup?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	fastMode?: boolean;
	modelFastModes?: Record<string, boolean>;
	modelCandidates?: string[];
	modelAttempts?: ModelAttempt[];
	codexFastModeSettings?: CodexFastModeResolvedSettings;
	codexFastModeScope?: CodexFastModeScope;
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	outputPath?: string;
	outputMode?: "inline" | "file-only" | "digest";
	sessionFile?: string;
	maxSubagentDepth?: number;
	workflowStageSubagentGuard?: boolean;
	structuredOutput?: {
		schema: import("../../shared/types.ts").JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	structuredOutputSchema?: import("../../shared/types.ts").JsonSchemaObject;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export interface DynamicRunnerGroup {
	expand: import("../../shared/settings.ts").DynamicExpandSpec;
	parallel: RunnerSubagentStep;
	collect: import("../../shared/settings.ts").DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | DynamicRunnerGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray(step.parallel);
}

export function isDynamicRunnerGroup(step: RunnerStep): step is DynamicRunnerGroup {
	return (
		"expand" in step &&
		"collect" in step &&
		"parallel" in step &&
		!Array.isArray((step as { parallel?: unknown }).parallel)
	);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else if (isDynamicRunnerGroup(step)) {
		} else {
			flat.push(step);
		}
	}
	return flat;
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(_workerIndex: number): Promise<void> {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)));
	return results;
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	status: import("../../shared/types.ts").SubagentAttemptStatus;
	error?: string;
	model?: string;
	fastMode?: boolean;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
	/** Where this task's full output already lives on disk, for the digest's pointer. */
	artifactOutputPath?: string;
}

/** The status label a reader needs before the body, or "" when the run was unremarkable. */
function statusLabel(r: ParallelTaskResult): string {
	const hasOutput = Boolean(r.output?.trim());
	if (r.status === "skipped") return "SKIPPED";
	if (r.status === "continued") return "CONTINUED";
	if (r.status === "error") return `FAILED${r.error ? `: ${r.error}` : ""}`;
	if (r.error) return `WARNING: ${r.error}`;
	if (!hasOutput && r.outputTargetPath && r.outputTargetExists === false) {
		return `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`;
	}
	if (!hasOutput && !r.outputTargetPath) return "EMPTY OUTPUT (no textual response returned)";
	return "";
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) => `=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const status = statusLabel(r);
			const hasOutput = Boolean(r.output?.trim());
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

/**
 * Order tasks for a bounded digest: **failures first, then task order.**
 *
 * Budget is spent down this list, so whatever sorts first survives verbatim and
 * whatever sorts last is what collapses. A silently collapsed error is the one
 * outcome a parent cannot recover from — it would read a summary that looked
 * fine — so failures are never the thing that gets dropped. Among equals, task
 * order, because that is the order the caller wrote them in and the only other
 * ranking that carries meaning here.
 */
export function orderForDigest(results: readonly ParallelTaskResult[]): ParallelTaskResult[] {
	const rank = (r: ParallelTaskResult): number => {
		if (r.status === "error") return 0;
		if (r.error) return 1;
		return 2;
	};
	return [...results].sort((a, b) => rank(a) - rank(b) || (a.taskIndex ?? 0) - (b.taskIndex ?? 0));
}

/**
 * Whether a parallel return should be bounded.
 *
 * Bounded is the default, but two cases keep the unbounded path deliberately.
 *
 * `inline` and `file-only` are contracts a caller explicitly asked for, and
 * quietly rewriting either is a worse surprise than a large result — `file-only`
 * in particular promises a concise reference rather than task output.
 *
 * The second is the more interesting one: a digest is only honest when every
 * task it might collapse has somewhere to be read from. Artifacts supply that
 * path, and they can be switched off. Bounding without them would not relocate
 * content, it would discard it — so when any task lacks a path, nothing is
 * bounded. A bound that loses what it drops is not a bound worth having.
 */
export function shouldDigestParallelReturn(
	outputMode: string | undefined,
	results: readonly ParallelTaskResult[],
): boolean {
	if (outputMode !== undefined && outputMode !== "digest") return false;
	return results.every((task) => Boolean(task.artifactOutputPath));
}

export interface ParallelDigestOptions {
	/** Total character budget for the rendered body. Default 2000, matching the room digest. */
	budget?: number;
	/** Per-task cap for verbatim bodies. Default 600, matching the room digest. */
	perTaskCap?: number;
	/** Cap for headline fragments. Default 100. */
	headlineCap?: number;
}

/**
 * Render parallel task outputs within a character budget.
 *
 * The counterpart to {@link aggregateParallelOutputs}, which concatenates every
 * child's output in full and is bounded only by a blunt 200 KB truncation far
 * past the point where the parent's context is the scarce resource. This spends
 * a budget instead, degrades what does not fit to one-line headlines, and
 * collapses the rest to a count — the same three tiers a room digest uses,
 * through the same `boundedRender` core, so the two boundaries cannot drift
 * into disagreeing about what bounded means.
 *
 * Nothing is lost: each task's full output is already on disk as an artifact,
 * and every rendered line carries the path to it. The collapse marker says so
 * too, because a bound the reader cannot see past is a bound that hides things.
 */
export function digestParallelOutputs(
	results: readonly ParallelTaskResult[],
	options: ParallelDigestOptions = {},
): string {
	const header = (r: ParallelTaskResult): string => `=== Task ${(r.taskIndex ?? 0) + 1}: ${r.agent} ===`;
	const pointer = (r: ParallelTaskResult): string =>
		r.artifactOutputPath ? `\n→ full output: ${r.artifactOutputPath}` : "";

	const rendered = boundedRender(orderForDigest(results), {
		budget: options.budget,
		perItemCap: options.perTaskCap,
		headlineCap: options.headlineCap,
		// Failures already sort first; printing in that same order puts them where
		// a reader looks first rather than burying them under successes.
		preserveOrder: true,
		format: {
			text: (r) => {
				const status = statusLabel(r);
				const hasOutput = Boolean(r.output?.trim());
				return status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			},
			verbatim: (r, capped, truncated) => {
				const marker = truncated > 0 ? ` …(+${truncated} chars)` : "";
				return `${header(r)}\n${capped}${marker}${pointer(r)}`;
			},
			headline: (r, capped, hasMore) =>
				`· Task ${(r.taskIndex ?? 0) + 1} (${r.agent}): ${capped}${hasMore ? " …" : ""}${pointer(r)}`,
			collapsed: (count) =>
				`(${count} more task output${count === 1 ? "" : "s"} collapsed — read the artifact files above, or re-run with outputMode: "inline")`,
		},
	});

	return rendered.text;
}

export const MAX_PARALLEL_CONCURRENCY = 4;
