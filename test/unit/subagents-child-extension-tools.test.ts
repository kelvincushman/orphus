import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { createChildResourceLoader } from "../../packages/subagents/src/runs/inprocess/runner.ts";

function sampleAgent(overrides?: Partial<AgentConfig>): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
		...overrides,
	};
}

test("child resource loader discovers builtin extension packages", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-child-ext-loader-"));
	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = createChildResourceLoader(sampleAgent(), cwd, agentDir, settingsManager);
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		assert.deepEqual(errors, []);
		assert.ok(
			extensions.some((extension) => extension.path.includes("roundtable")),
			`builtin roundtable extension missing from: ${extensions.map((extension) => extension.path).join(", ")}`,
		);
		assert.ok(
			extensions.some((extension) => extension.path.includes("subagents")),
			"builtin subagents extension missing: nested fan-out would be impossible in children",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("child session with a roundtable grant exposes the roundtable tool", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-child-ext-session-"));
	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = createChildResourceLoader(sampleAgent(), cwd, agentDir, settingsManager);
		await resourceLoader.reload();
		const sessionManager = SessionManager.create(cwd, join(root, "sessions"), { internal: true });
		const { session } = await createAgentSession({
			cwd,
			tools: ["read", "search", "roundtable"],
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		try {
			const active = session.getActiveToolNames();
			assert.ok(
				active.includes("roundtable"),
				`roundtable missing from allowlisted child tools: ${[...active].sort().join(", ")}`,
			);
			assert.deepEqual([...active].sort(), ["read", "roundtable", "search"]);
		} finally {
			await session.abort();
			session.dispose?.();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
