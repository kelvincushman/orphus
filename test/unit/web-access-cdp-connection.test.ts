import assert from "node:assert/strict";
import { test } from "vitest";
import { CdpConnection, type CdpSocket } from "../../packages/web-access/cdp/connection.js";

function fakeSocket(): { socket: CdpSocket; emit: (data: string) => void; sent: string[] } {
	const listeners: Record<string, ((ev: { data?: string }) => void)[]> = { message: [], close: [], error: [] };
	const sent: string[] = [];
	const socket: CdpSocket = {
		send: (data) => sent.push(data),
		close: () => {
			listeners.close.forEach((cb) => {
				cb({});
			});
		},
		addEventListener: (type, cb) => listeners[type].push(cb),
	};
	return {
		socket,
		emit: (data) => {
			listeners.message.forEach((cb) => {
				cb({ data });
			});
		},
		sent,
	};
}

test("send resolves with the CDP result matched by id", async () => {
	const f = fakeSocket();
	const cdp = await CdpConnection.open("ws://x", () => f.socket);
	const pending = cdp.send("Page.navigate", { url: "https://example.com" });
	const req = JSON.parse(f.sent.at(-1) as string) as { id: number; method: string; params: unknown };
	assert.equal(req.method, "Page.navigate");
	f.emit(JSON.stringify({ id: req.id, result: { frameId: "F1" } }));
	assert.deepEqual(await pending, { frameId: "F1" });
});

test("a CDP error rejects the matching call", async () => {
	const f = fakeSocket();
	const cdp = await CdpConnection.open("ws://x", () => f.socket);
	const pending = cdp.send("Bad.method");
	const req = JSON.parse(f.sent.at(-1) as string) as { id: number };
	f.emit(JSON.stringify({ id: req.id, error: { code: -32000, message: "no such method" } }));
	await assert.rejects(pending, /CDP error -32000: no such method/);
});
