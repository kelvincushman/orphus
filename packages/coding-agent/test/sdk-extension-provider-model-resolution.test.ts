import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

// Subagent and fleet children build their session through createAgentSession
// with a fresh ModelRuntime, not through createAgentSessionServices. A provider
// registered by an extension (claude-bridge, for one) must be visible to model
// resolution there too, and a pinned model reference must be honoured.

const bridgeProvider: ExtensionFactory = (pi) => {
	pi.registerProvider("ext-bridge", {
		api: "openai-completions",
		baseUrl: "https://ext-bridge.invalid/v1",
		apiKey: "test-key",
		models: [
			{
				id: "bridge-model",
				name: "bridge-model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	});
};

describe("createAgentSession with extension-registered providers", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `orphus-sdk-ext-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function create(options: { modelReference?: string; settings?: Record<string, string> }) {
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		return createAgentSession({
			cwd,
			agentDir: join(tempDir, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory(options.settings ?? {}),
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader: createTestResourceLoader({
				extensionsResult: await createTestExtensionsResult([bridgeProvider], cwd),
			}),
			...(options.modelReference ? { modelReference: options.modelReference } : {}),
		});
	}

	it("resolves a default model whose provider an extension registers", async () => {
		const { session, modelFallbackReason } = await create({
			settings: { defaultProvider: "ext-bridge", defaultModel: "bridge-model" },
		});

		expect(modelFallbackReason).toBeUndefined();
		expect(session.model?.provider).toBe("ext-bridge");
		expect(session.model?.id).toBe("bridge-model");
		session.dispose();
	});

	it("uses a pinned model reference, including its thinking suffix", async () => {
		const { session } = await create({ modelReference: "ext-bridge/bridge-model:high" });

		expect(session.model?.provider).toBe("ext-bridge");
		expect(session.model?.id).toBe("bridge-model");
		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});

	it("fails with a clear error for a pinned model that does not resolve", async () => {
		await expect(create({ modelReference: "ext-bridge/no-such-model" })).rejects.toThrow(
			"Unknown model ext-bridge/no-such-model",
		);
	});
});
