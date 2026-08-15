import type { ExtensionAPI, ExtensionContext } from "@orphus/coding-agent";
import type { AgentConfig, AgentScope } from "../../agents/agents.ts";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { ChainStep } from "../../shared/settings.ts";
import type {
	ArtifactConfig,
	ControlConfig,
	MaxOutputConfig,
	NestedRouteInfo,
	ResolvedControlConfig,
	SUBAGENT_ACTIONS,
	SubagentState,
	SubagentToolResult,
} from "../../shared/types.ts";
import type {
	AsyncExecutionResult,
	AsyncSingleParams,
	formatAsyncStartedMessage,
	isAsyncAvailable,
} from "../inprocess/background.ts";
import type { ChildModePolicy } from "../inprocess/child-policy.ts";
import type { runSync } from "./execution.ts";

export interface TaskParam {
	agent: string;
	task: string;
	/** Replaces the agent's tool allowlist for this task. */
	tools?: string[];
	/** Session name for the child; roundtable room cursors are keyed by it. */
	name?: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only" | "digest";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	group?: string | true;
}

export interface SubagentParamsLike {
	action?: (typeof SUBAGENT_ACTIONS)[number];
	id?: string;
	/** SINGLE mode: replaces the agent's tool allowlist. */
	tools?: string[];
	/** SINGLE mode: session name for the child (roundtable identity). */
	name?: string;
	runId?: string;
	dir?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	chainName?: string;
	config?: unknown;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	/** Wall-clock ceiling for an async run, in ms. Interrupts and finalizes on expiry. */
	deadlineMs?: number;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	group?: string | true;
	output?: string | boolean;
	outputMode?: "inline" | "file-only" | "digest";
	reads?: string[] | false;
	progress?: boolean;
	agentScope?: string;
	chainDir?: string;
}

export interface SubagentExecutorRuntimeDeps {
	runSync: typeof runSync;
	executeAsyncSingle: (id: string, params: AsyncSingleParams) => AsyncExecutionResult | Promise<AsyncExecutionResult>;
	isAsyncAvailable: typeof isAsyncAvailable;
	formatAsyncStartedMessage: typeof formatAsyncStartedMessage;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: import("../../shared/types.ts").ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	allowMutatingManagementActions?: boolean;
	/** Typed admission policy; when present it is authoritative over the legacy boolean. */
	childPolicy?: ChildModePolicy;
	runtime?: Partial<SubagentExecutorRuntimeDeps>;
}

export function isManagementActionsRestricted(
	deps: Pick<ExecutorDeps, "childPolicy" | "allowMutatingManagementActions">,
): boolean {
	return deps.childPolicy
		? deps.childPolicy.managementActions === "restricted"
		: deps.allowMutatingManagementActions === false;
}
export interface ResolvedExecutorDeps extends Omit<ExecutorDeps, "runtime"> {
	runtime: SubagentExecutorRuntimeDeps;
}

export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: SubagentToolResult) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
}

export interface PreparedExecutionContext {
	effectiveParams: SubagentParamsLike;
	effectiveCwd: string;
	runId: string;
	hasChain: boolean;
	hasTasks: boolean;
	hasSingle: boolean;
	foregroundMode: "single" | "parallel" | "chain";
	execData: ExecutionContextData;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	writeNestedForegroundEvent: (
		type: "subagent.nested.started" | "subagent.nested.completed",
		result?: SubagentToolResult,
	) => void;
}

export interface ExecutionContextBuildResult {
	prepared?: PreparedExecutionContext;
	error?: SubagentToolResult;
}

export type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
export type AvailableModelInfo = ModelInfo;
