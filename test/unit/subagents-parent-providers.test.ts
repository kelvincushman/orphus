import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@orphus/coding-agent";
import { test } from "vitest";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import {
	inheritParentProviders,
	withParentModelRegistry,
} from "../../packages/subagents/src/runs/inprocess/parent-providers.ts";

// claude-bridge, loaded a second time in one process, defers its provider
// registration to session_start, which in-process children never emit. A child
// pinned to `claude-bridge/<model>` therefore found no such provider, while the
// parent used it fine. The child now inherits the parent's extension providers.

const bridgeConfig = {
	api: "openai-completions" as const,
	baseUrl: "https://ext-bridge.invalid/v1",
	apiKey: "test-key",
	models: [
		{
			id: "bridge-model",
			name: "bridge-model",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		},
	],
};

async function parentRegistry(): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("ext-bridge", bridgeConfig);
	await runtime.refresh({ allowNetwork: false });
	return new ModelRegistry(runtime);
}

function childLoader(): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

async function createChild(loader: ResourceLoader, cwd: string) {
	return createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		}),
		settingsManager: SettingsManager.inMemory({}),
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader: loader,
		modelReference: "ext-bridge/bridge-model",
	});
}

test("a child resolves a pin on a provider only its parent registered", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "orphus-parent-providers-"));
	try {
		const registry = await parentRegistry();
		await assert.rejects(createChild(childLoader(), cwd), /Unknown model ext-bridge\/bridge-model/);

		const loader = childLoader();
		withParentModelRegistry(registry, () => inheritParentProviders(loader));
		const { session } = await createChild(loader, cwd);
		assert.equal(session.model?.provider, "ext-bridge");
		assert.equal(session.model?.id, "bridge-model");
		session.dispose();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a provider the child's own extensions registered wins over the parent's", async () => {
	const registry = await parentRegistry();
	const loader = childLoader();
	const own = { ...bridgeConfig, baseUrl: "https://child.invalid/v1" };
	loader.getExtensions().runtime.pendingProviderRegistrations.push({
		name: "ext-bridge",
		config: own,
		extensionPath: "<child>",
	});
	inheritParentProviders(loader, registry);
	const pending = loader.getExtensions().runtime.pendingProviderRegistrations;
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.extensionPath, "<child>");
});

test("nothing is inherited outside a subagent call", () => {
	const loader = childLoader();
	inheritParentProviders(loader);
	assert.equal(loader.getExtensions().runtime.pendingProviderRegistrations.length, 0);
});
