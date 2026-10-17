import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions, ModelRegistry } from "@orphus/coding-agent";
import { test, vi } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { withParentModelRegistry } from "../../packages/subagents/src/runs/inprocess/parent-providers.ts";
import { SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.ts";

// A fleet member's `model:` pin reaches the runner only as `candidate.modelId`.
// It must be handed to createAgentSession, which resolves it after extension
// providers are registered; dropping it left children on the unresolved
// placeholder model ("No API key found for the selected model").

const captured: CreateAgentSessionOptions[] = [];

vi.mock("@orphus/coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@orphus/coding-agent")>();
	class StubResourceLoader {
		private readonly runtime = { pendingProviderRegistrations: [] as unknown[] };
		async reload(): Promise<void> {}
		getExtensions() {
			return { extensions: [], errors: [], runtime: this.runtime };
		}
	}
	return {
		...original,
		DefaultResourceLoader: StubResourceLoader,
		createAgentSession: async (options: CreateAgentSessionOptions) => {
			captured.push(options);
			throw new Error("session creation captured");
		},
	};
});

function sampleAgent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
	};
}

test("a pinned model id reaches createAgentSession as a model reference", async () => {
	const root = mkdtempSync(join(tmpdir(), "orphus-inprocess-model-pin-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{ taskName: "analysis", task: "inspect the fixture", agent: sampleAgent(), cwd: root },
			{ path: "parent", depth: 0 },
		).admitted;
		assert.ok(admitted);
		const never = new AbortController().signal;
		const running = control.startAttempt(
			admitted,
			{ modelId: "zai/glm-5.3:high" },
			{ abort: never, interrupt: never },
		);
		const outcome = await running.promise;

		assert.equal(outcome.status, "error");
		assert.equal(captured.length, 1);
		assert.equal(captured[0]?.modelReference, "zai/glm-5.3:high");
		assert.equal(captured[0]?.model, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a child attempt inherits the providers of the session that called subagent", async () => {
	const root = mkdtempSync(join(tmpdir(), "orphus-inprocess-parent-providers-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{ taskName: "analysis", task: "inspect the fixture", agent: sampleAgent(), cwd: root },
			{ path: "parent", depth: 0 },
		).admitted;
		assert.ok(admitted);
		const config = { api: "claude-bridge", baseUrl: "claude-bridge", apiKey: "not-used", models: [] };
		const parentRegistry = {
			getRegisteredProviderIds: () => ["claude-bridge"],
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: (id: string) => (id === "claude-bridge" ? config : undefined),
		} as unknown as ModelRegistry;
		const never = new AbortController().signal;
		const before = captured.length;
		await withParentModelRegistry(
			parentRegistry,
			() =>
				control.startAttempt(
					admitted,
					{ modelId: "claude-bridge/claude-opus-5" },
					{ abort: never, interrupt: never },
				).promise,
		);

		const options = captured[before];
		assert.ok(options?.resourceLoader);
		assert.deepEqual(options.resourceLoader.getExtensions().runtime.pendingProviderRegistrations, [
			{ name: "claude-bridge", config, extensionPath: "<parent session>" },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
