import type { AgentConfig } from "../../agents/agents.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { collectKnownModelProviders, type ModelInfo, toModelInfo } from "../../shared/model-info.ts";
import {
	resolveStepBehavior,
	type StepOverrides,
	suppressProgressForReadOnlyTask,
	writeInitialProgressFile,
} from "../../shared/settings.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	resolveChildMaxSubagentDepth,
	resolveSubagentDepthPolicy,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	type SingleResult,
	type SubagentToolResult,
	wrapForkTask,
} from "../../shared/types.ts";
import { compactForegroundDetails, getSingleResultOutput } from "../../shared/utils.ts";
import { updateForegroundNestedProjection } from "../inprocess/runtime-support/nested-api.ts";
import { sharedAutoGroupForSet } from "../shared/intercom-group.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import {
	aggregateParallelOutputs,
	buildInterruptedParallelMessage,
	digestParallelOutputs,
	shouldDigestParallelReturn,
} from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import { resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { cleanupWorktrees, type WorktreeSetup } from "../shared/worktree.ts";
import { createDetachedCleanupBarrier } from "./detached-cleanup-barrier.ts";
import { runForegroundParallelTasks } from "./subagent-executor-parallel-task.ts";
import {
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	notifyDetachedForegroundChildExit,
	rememberForegroundRun,
	replaceForegroundRunChild,
} from "./subagent-executor-status.ts";
import type { ExecutionContextData, ResolvedExecutorDeps, TaskParam } from "./subagent-executor-types.ts";
import {
	buildParallelModeError,
	buildParallelWorktreeSuffix,
	buildParallelWorktreeTaskCwdError,
	createParallelWorktreeSetup,
	findDuplicateParallelOutputPath,
	resolveParallelTaskCwd,
} from "./subagent-executor-worktree.ts";

export async function runParallelPath(
	data: ExecutionContextData,
	deps: ResolvedExecutorDeps,
): Promise<SubagentToolResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(
		params.concurrency,
		deps.config.parallel?.concurrency,
	);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const depthPolicy = resolveSubagentDepthPolicy(ctx, deps.config.maxSubagentDepth);
	const currentMaxSubagentDepth = depthPolicy.maxSubagentDepth;
	const workflowStageSubagentGuard = depthPolicy.workflowStageSubagentGuard;
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const knownModelProviders = collectKnownModelProviders(ctx.modelRegistry);
	const taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) => normalizeSkillInput(t.skill));
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined
			? { output: task.output === true ? (agentConfigs[index]?.output ?? false) : task.output }
			: {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveModelCandidate(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);

	const behaviors = agentConfigs.map((config, index) =>
		suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]),
	);
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	let worktreeCleanupDeferred = false;
	const detachedCleanup = createDetachedCleanupBarrier(() => {
		if (!worktreeSetup) return;
		buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks as TaskParam[]);
		cleanupWorktrees(worktreeSetup);
	});
	if (errorResult) return errorResult;

	try {
		const duplicateOutputError = findDuplicateParallelOutputPath({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			worktreeSetup,
		});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd);
			const validationError = validateFileOnlyOutputMode(
				behaviors[index]?.outputMode,
				outputPath,
				`Parallel task ${index + 1} (${tasks[index]!.agent})`,
			);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		if (parallelProgressPrecreated) writeInitialProgressFile(effectiveCwd);

		if (params.context === "fork") {
			for (let i = 0; i < taskTexts.length; i++) {
				taskTexts[i] = wrapForkTask(taskTexts[i]!);
			}
		}

		const results = await runForegroundParallelTasks({
			onDetachedExit: (index, result) => {
				try {
					replaceForegroundRunChild(deps.state, runId, index, result);
					notifyDetachedForegroundChildExit({
						pi: deps.pi,
						runId,
						mode: "parallel",
						index,
						totalTasks: tasks.length,
						result,
					});
				} finally {
					detachedCleanup.recover(index);
				}
			},
			tasks,
			taskTexts,
			agents,
			ctx,
			intercomEvents: deps.pi.events,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			workflowStageSubagentGuard,
			availableModels,
			knownModelProviders,
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			onControlEvent,
			childIntercomTarget: childIntercomTarget
				? (agent, index) => childIntercomTarget(runId, agent, index)
				: undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			setIntercomGroup: params.group,
			sharedAutoIntercomGroup: sharedAutoGroupForSet(params.group, tasks),
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			maxSubagentDepths,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup: worktreeSetup as WorktreeSetup | undefined,
			runtime: deps.runtime,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.status, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const interrupted = results.find((result) => result.interrupted);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, results: details.results });
		if (interrupted) {
			const text = buildInterruptedParallelMessage({
				results,
				deadlineExpired: deps.state.foregroundControls.get(runId)?.deadlineExpired === true,
				interruptedAgent: interrupted.agent,
			});
			return { content: [{ type: "text", text }], details };
		}
		const detachedIndex = results.findIndex((result) => result.detached);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		worktreeCleanupDeferred = detachedCleanup.defer(
			results.flatMap((result, index) => (result.detached ? [index] : [])),
		);
		if (detached) {
			return {
				content: [
					{
						type: "text",
						text: `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.`,
					},
				],
				details,
			};
		}

		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
			};
		}

		const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks as TaskParam[]);
		const ok = results.filter((result) => result.status === "ok").length;
		const rendered = results.map((result, index) => ({
			agent: result.agent,
			taskIndex: index,
			output: result.truncation?.text || getSingleResultOutput(result),
			status: result.status,
			error: result.error,
			artifactOutputPath: result.artifactPaths?.outputPath,
		}));
		// Bounded by default. Inlining every child's output put the parent's
		// context at the mercy of what the children happened to emit, guarded only
		// by a 200 KB truncation that fires long after the damage.
		//
		// Two cases deliberately keep the old path. `inline` and `file-only` are
		// explicit contracts a caller asked for, and quietly rewriting either would
		// be a worse surprise than a large result. And a digest is only honest when
		// every task it may collapse has somewhere to be read from: with artifacts
		// disabled there is no such path, so bounding would discard content instead
		// of relocating it.
		const aggregatedOutput = shouldDigestParallelReturn(params.outputMode, rendered)
			? digestParallelOutputs(rendered)
			: aggregateParallelOutputs(rendered, (i, agent) => `=== Task ${i + 1}: ${agent} ===`);

		const summary = `${ok}/${results.length} succeeded`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} finally {
		if (worktreeSetup && !worktreeCleanupDeferred) cleanupWorktrees(worktreeSetup);
	}
}
