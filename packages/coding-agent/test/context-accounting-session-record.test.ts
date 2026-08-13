import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AsyncJobManager } from "../src/core/async/job-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CONTEXT_ACCOUNTING_CUSTOM_TYPE, type ContextAccountingSnapshot } from "../src/core/context-accounting.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

/** The accounting is internal state; a test may reach it, ordinary callers may not. */
type SessionWithAccounting = AgentSession & {
	_contextAccounting: {
		record(entry: { toolName: string; chars: number; originalChars: number; spilled: boolean }): void;
	};
};

async function createSession(tempDir: string): Promise<AgentSession> {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		// No turn is ever run here: the accounting is driven directly and the
		// session is disposed, which is the path under test.
		streamFn: () =>
			new EventStream(
				(event) => event.type === "done",
				() => undefined as never,
			),
	});
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRuntime: await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		}),
		resourceLoader: createTestResourceLoader(),
	});
}

function findAccountingEntry(session: AgentSession): ContextAccountingSnapshot | undefined {
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === CONTEXT_ACCOUNTING_CUSTOM_TYPE) {
			return entry.data as ContextAccountingSnapshot;
		}
	}
	return undefined;
}

describe("context accounting reaches the session record", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `orphus-context-record-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session = undefined;
		AsyncJobManager.instance()?.dispose();
		AsyncJobManager.resetForTests();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("writes one custom entry on dispose carrying totals, per-tool figures and the summary", async () => {
		session = await createSession(tempDir);
		const internal = session as SessionWithAccounting;
		internal._contextAccounting.record({ toolName: "read", chars: 400, originalChars: 400, spilled: false });
		internal._contextAccounting.record({ toolName: "bash", chars: 2_000, originalChars: 120_000, spilled: true });

		expect(findAccountingEntry(session), "nothing is written before dispose").toBeUndefined();

		session.dispose();

		const snapshot = findAccountingEntry(session);
		expect(snapshot).toBeDefined();
		expect(snapshot?.totals).toEqual({ calls: 2, chars: 2_400, originalChars: 120_400, spilled: 1 });
		// Heaviest first, so a reader sees the dominant contributor without sorting.
		expect(Object.keys(snapshot?.byTool ?? {})).toEqual(["bash", "read"]);
		expect(snapshot?.summary).toMatch(/spilled to disk/);
	});

	it("writes nothing for a session that ran no tool", async () => {
		session = await createSession(tempDir);
		session.dispose();
		expect(findAccountingEntry(session)).toBeUndefined();
	});

	it("survives a JSON round-trip, which is how the entry is actually read back", async () => {
		session = await createSession(tempDir);
		const internal = session as SessionWithAccounting;
		internal._contextAccounting.record({ toolName: "read", chars: 10, originalChars: 10, spilled: false });
		session.dispose();

		const snapshot = findAccountingEntry(session);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
	});
});
