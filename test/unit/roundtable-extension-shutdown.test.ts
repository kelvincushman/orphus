import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
	clients: [] as Array<{ connected: boolean; disconnectCalls: number; rejectConnect?: (error: Error) => void }>,
}));

vi.mock("../../packages/roundtable/broker/spawn.ts", () => ({
	ensureBrokerRunning: vi.fn(async () => {}),
}));

vi.mock("../../packages/roundtable/broker/client.ts", () => ({
	RoundtableClient: class {
		connected = false;
		disconnectCalls = 0;
		rejectConnect?: (error: Error) => void;

		constructor() {
			harness.clients.push(this);
		}

		connect(): Promise<void> {
			return new Promise((_resolve, reject) => {
				this.rejectConnect = reject;
			});
		}

		disconnect(): void {
			this.disconnectCalls += 1;
			this.connected = false;
			this.rejectConnect?.(new Error("connection cancelled"));
		}

		onActivity(): () => void {
			return () => {};
		}
	},
}));

import roundtableExtension from "../../packages/roundtable/index.ts";

describe("roundtable extension shutdown", () => {
	it("cancels an in-flight client and prevents reconnect after shutdown", async () => {
		harness.clients.length = 0;
		let execute:
			| ((...args: unknown[]) => Promise<{ isError: boolean; content: Array<{ text: string }> }>)
			| undefined;
		let shutdown: (() => void) | undefined;
		const pi = {
			getSessionName: () => "planner",
			registerTool: (definition: { name: string; execute?: typeof execute }) => {
				if (definition.name === "roundtable") execute = definition.execute;
			},
			on: (event: string, handler: () => void) => {
				if (event === "session_shutdown") shutdown = handler;
			},
			sendMessage: vi.fn(),
		};
		roundtableExtension(pi as never);
		if (!execute || !shutdown) throw new Error("roundtable extension did not register expected hooks");

		const request = execute("rooms", { action: "rooms" }, undefined, undefined, undefined);
		await vi.waitFor(() => expect(harness.clients).toHaveLength(1));
		shutdown();
		const result = await request;
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/connection cancelled|shutting down/);
		expect(harness.clients[0]?.disconnectCalls).toBe(1);

		const afterShutdown = await execute("rooms", { action: "rooms" }, undefined, undefined, undefined);
		expect(afterShutdown.isError).toBe(true);
		expect(afterShutdown.content[0]?.text).toMatch(/shutting down/);
		expect(harness.clients).toHaveLength(1);
	});
});
