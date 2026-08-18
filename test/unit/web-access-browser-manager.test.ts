import assert from "node:assert/strict";
import { test } from "vitest";
import type { CdpConnection } from "../../packages/web-access/cdp/connection.js";
import { BrowserManager } from "../../packages/web-access/browser-manager.js";
import { findChrome } from "../../packages/web-access/find-chrome.js";
import { installBunGlobal } from "../helpers/runtime.js";

// browser-manager.ts's default spawn calls Bun.spawn unguarded (same convention as
// packages/web-access/subprocess.ts), because it only ever runs inside the
// Bun-compiled binary. The two deterministic tests above never reach that path
// (they inject a fake spawn); the guarded smoke test below uses the real default,
// so it needs the Bun global under vitest's Node environment. See installBunGlobal.
installBunGlobal();

function fakes() {
	const killed: string[] = [];
	const spawn = (_bin: string, _args: string[]) => ({ pid: 1000 + killed.length, kill: (_s?: string) => killed.push(_bin) });
	const wsEndpoint = async (_port: number) => "ws://127.0.0.1/devtools/browser/xyz";
	const connect = async (_wsUrl: string) => ({ close() {} }) as unknown as CdpConnection;
	return { killed, spawn, wsEndpoint, connect };
}

test("stopAll kills every launched instance", async () => {
	const f = fakes();
	const m = new BrowserManager({ spawn: f.spawn, wsEndpoint: f.wsEndpoint, profileRoot: "/tmp/x", connect: f.connect });
	await m.launch("a");
	await m.launch("b");
	await m.stopAll();
	assert.equal(f.killed.length, 2);
	assert.equal(m.get("a"), undefined);
});

test("launch refuses past the cap with a typed error", async () => {
	const f = fakes();
	const m = new BrowserManager({
		spawn: f.spawn,
		wsEndpoint: f.wsEndpoint,
		profileRoot: "/tmp/x",
		maxInstances: 1,
		connect: f.connect,
	});
	await m.launch("a");
	await assert.rejects(m.launch("b"), (e: Error) => e.name === "CapacityExhausted");
});

const hasChrome = findChrome() !== null;

test.skipIf(!hasChrome)("launches real headless Chrome and navigates", async () => {
	const m = new BrowserManager();
	try {
		const h = await m.launch("smoke");
		await h.cdp.send("Page.navigate", { url: "data:text/html,<title>ok</title>" });
		const r = (await h.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })) as {
			result: { value: string };
		};
		assert.equal(r.result.value, "ok");
	} finally {
		// Ensure the real Chrome process is always killed, even on assertion failure,
		// so a failing run does not leak a headless Chrome process on the machine.
		await m.stopAll();
	}
});
