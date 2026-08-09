import assert from "node:assert/strict";
import { test } from "vitest";
import type { RoundtableClient } from "../../packages/roundtable/broker/client.js";
import { createBridgeDeps } from "../../packages/roundtable/mcp/bridge-deps.js";

/** Minimal client stand-in: records construction and connects instantly. */
function fakeClientFactory(log: string[]) {
	return (role: string): RoundtableClient => {
		log.push(`make:${role}`);
		let connected = false;
		return {
			name: role,
			get connected() {
				return connected;
			},
			connect: async () => {
				log.push(`connect:${role}`);
				connected = true;
			},
			disconnect: () => {
				log.push(`disconnect:${role}`);
				connected = false;
			},
		} as unknown as RoundtableClient;
	};
}

test("construction is lazy: no broker ensure and no client until the first call", () => {
	const log: string[] = [];
	createBridgeDeps("critic", {
		ensureBroker: async () => {
			log.push("ensure");
		},
		makeClient: fakeClientFactory(log),
	});
	assert.deepEqual(log, []);
});

test("first call ensures the broker, then connects a client named after the pinned role", async () => {
	const log: string[] = [];
	const deps = createBridgeDeps("critic", {
		ensureBroker: async () => {
			log.push("ensure");
		},
		makeClient: fakeClientFactory(log),
	});
	const client = await deps.ensureConnected();
	assert.equal(client.name, "critic");
	assert.deepEqual(log, ["ensure", "make:critic", "connect:critic"]);
});

test("concurrent first calls share one in-flight connection", async () => {
	const log: string[] = [];
	const deps = createBridgeDeps("critic", {
		ensureBroker: async () => {
			log.push("ensure");
		},
		makeClient: fakeClientFactory(log),
	});
	const [a, b] = await Promise.all([deps.ensureConnected(), deps.ensureConnected()]);
	assert.equal(a, b);
	assert.deepEqual(log, ["ensure", "make:critic", "connect:critic"]);
});

test("currentRole returns the pinned role, always", () => {
	const deps = createBridgeDeps("critic", {
		ensureBroker: async () => {},
		makeClient: fakeClientFactory([]),
	});
	assert.equal(deps.currentRole(), "critic");
});

test("a broker-ensure failure names the socket path", async () => {
	const deps = createBridgeDeps("critic", {
		ensureBroker: async () => {
			throw new Error("Roundtable broker did not start in time");
		},
		makeClient: fakeClientFactory([]),
	});
	await assert.rejects(deps.ensureConnected(), (error: Error) => {
		assert.match(error.message, /did not start in time/u);
		assert.match(error.message, /broker\.sock/u);
		return true;
	});
});

test("disconnect drops the client so the next call reconnects", async () => {
	const log: string[] = [];
	const deps = createBridgeDeps("critic", {
		ensureBroker: async () => {
			log.push("ensure");
		},
		makeClient: fakeClientFactory(log),
	});
	await deps.ensureConnected();
	deps.disconnect();
	await deps.ensureConnected();
	assert.deepEqual(log, [
		"ensure",
		"make:critic",
		"connect:critic",
		"disconnect:critic",
		"ensure",
		"make:critic",
		"connect:critic",
	]);
});
