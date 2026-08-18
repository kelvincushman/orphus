import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import { AuthStorage } from "../auth-storage.ts";
import type { HarnessCapabilities, HarnessCapabilityOverrides } from "../capabilities/index.ts";
import { createFakeCapabilities } from "../capabilities/index.ts";
import type { InlineExtension, ToolDefinition } from "../extensions/index.ts";
import { ModelRuntime } from "../model-runtime.ts";
import type { ProviderRequestRecord, ProviderResponseRecord } from "../provider-audit.ts";
import { PROVIDER_REQUEST_ENTRY, PROVIDER_RESPONSE_ENTRY } from "../provider-audit.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { SessionEntry } from "../session-manager-types.ts";
import { SettingsManager } from "../settings-manager.ts";
import type { ToolAuditRecord } from "../tool-audit.ts";
import { TOOL_AUDIT_ENTRY } from "../tool-audit.ts";
import { createScriptedProvider, type ScriptedProvider, type ScriptedTurn } from "./scripted-provider.ts";

/** Provider id the replay harness registers its scripted backend under. */
export const REPLAY_PROVIDER = "orphus-replay";
export const REPLAY_MODEL_ID = "replay-model";
export const REPLAY_API: Api = "anthropic-messages";
export const REPLAY_BASE_URL = "http://replay.invalid";

export interface ReplayRuntimeOptions {
	/** Model replies, consumed in order. A turn beyond the script replies with empty text. */
	script?: ScriptedTurn[];
	capabilities?: HarnessCapabilityOverrides;
	/** Extra tools registered on the session, for exercising the tool pipeline. */
	customTools?: ToolDefinition[];
	extensionFactories?: InlineExtension[];
	/** Active tool names. Defaults to none, so a replay does not drag in the builtin tool set. */
	tools?: string[];
	settings?: Record<string, unknown>;
}

export interface ReplayRuntime {
	session: AgentSession;
	capabilities: HarnessCapabilities;
	provider: ScriptedProvider;
	model: Model<Api>;
	cwd: string;
	/** Every session entry, including the audit records. */
	entries(): SessionEntry[];
	providerRequests(): ProviderRequestRecord[];
	providerResponses(): ProviderResponseRecord[];
	toolAudits(): ToolAuditRecord[];
	dispose(): void;
}

function customEntries<T>(entries: SessionEntry[], customType: string): T[] {
	return entries
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
		.filter((entry) => entry.customType === customType)
		.map((entry) => entry.data as T);
}

/**
 * Boot the production composition — real resource loader, real `createAgentSession`,
 * real tool and provider pipelines — against fake capabilities and a scripted
 * provider.
 *
 * This is deliberately not a miniature stand-in for the runtime: a test that
 * passes here passes against the same wiring a user runs, which is the only way
 * assertions about recording, hook order, and replay equivalence mean anything.
 */
export async function createReplayRuntime(options: ReplayRuntimeOptions = {}): Promise<ReplayRuntime> {
	const cwd = mkdtempSync(join(tmpdir(), "orphus-replay-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });

	const capabilities = createFakeCapabilities(options.capabilities);
	const settingsManager = SettingsManager.inMemory(options.settings ?? {});
	const sessionManager = SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: options.extensionFactories,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	// A placeholder credential, so the session's own "is this provider configured"
	// preflight passes. The scripted backend never reads it and never dials out.
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	await authStorage.modify(REPLAY_PROVIDER, async () => ({ type: "api_key", key: "replay-placeholder-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const provider = createScriptedProvider(options.script ?? [], capabilities.clock);
	modelRuntime.registerProvider(REPLAY_PROVIDER, {
		api: REPLAY_API,
		// Never dialled — `streamSimple` answers every request — but the session's
		// preflight wants a provider that looks configured.
		baseUrl: REPLAY_BASE_URL,
		streamSimple: provider.streamSimple,
	});
	const model = {
		provider: REPLAY_PROVIDER,
		id: REPLAY_MODEL_ID,
		api: REPLAY_API,
		name: "Replay",
		baseUrl: REPLAY_BASE_URL,
	} as Model<Api>;

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		capabilities,
		customTools: options.customTools,
		tools: options.tools ?? [],
	});

	const entries = () => sessionManager.getEntries();
	return {
		session,
		capabilities,
		provider,
		model,
		cwd,
		entries,
		providerRequests: () => customEntries<ProviderRequestRecord>(entries(), PROVIDER_REQUEST_ENTRY),
		providerResponses: () => customEntries<ProviderResponseRecord>(entries(), PROVIDER_RESPONSE_ENTRY),
		toolAudits: () => customEntries<ToolAuditRecord>(entries(), TOOL_AUDIT_ENTRY),
		dispose: () => {
			session.dispose();
			modelRuntime.unregisterProvider(REPLAY_PROVIDER);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}
