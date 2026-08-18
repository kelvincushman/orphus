import assert from "node:assert/strict";
import { test } from "vitest";
import { BrowserManager } from "../../packages/web-access/browser-manager.js";
import { buildBrowserExecute } from "../../packages/web-access/browser-tool.js";
import { CredentialVault } from "../../packages/web-access/credential-vault.js";
import type { SecretBackend } from "../../packages/web-access/vault/keychain.js";
import { installBunGlobal } from "../helpers/runtime.js";

function memBackend(): SecretBackend {
	const m = new Map<string, string>();
	return {
		store: async (id, s) => void m.set(id, s),
		lookup: async (id) => m.get(id) ?? null,
		remove: async (id) => void m.delete(id),
	};
}

// wait_for's poll loop calls Bun.sleep between attempts (browser-tool.ts only ever runs inside
// the Bun-compiled binary, same convention as browser-manager.ts and subprocess.ts), so the
// polling regression test below needs the Bun global under vitest's Node environment.
installBunGlobal();

test("browser tool refuses when the flag is off", async () => {
	const execute = buildBrowserExecute(new BrowserManager(), { ORPHUS_ENABLE_BROWSER: undefined } as NodeJS.ProcessEnv);
	const out = await execute({ action: "open", url: "https://example.com" });
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /ORPHUS_ENABLE_BROWSER/);
});

test("failed actions mark details.error so the tool_result hook can flag them", async () => {
	// pi's agent loop hardcodes isError:false for any resolved execute() result, so the model-facing
	// error signal has to travel through details, not the isError field on the raw return value.
	const execute = buildBrowserExecute(new BrowserManager(), { ORPHUS_ENABLE_BROWSER: "1" } as NodeJS.ProcessEnv);
	const out = await execute({ action: "read" }); // no browser open under the default handle name
	assert.equal(out.isError, true);
	assert.equal(out.details.error, true);
});

test("login refuses with no credential vault wired", async () => {
	const send = async (method: string) => (method === "Runtime.evaluate" ? { result: { value: { x: 1, y: 1 } } } : {});
	const fakeManager = { get: () => ({ cdp: { send } }) } as unknown as BrowserManager;
	// vault omitted entirely (undefined) — simulates the try/catch in index-heavy.ts failing to construct one
	const execute = buildBrowserExecute(fakeManager, {
		ORPHUS_ENABLE_BROWSER: "1",
		ORPHUS_ENABLE_BROWSER_LOGIN: "1",
	} as NodeJS.ProcessEnv);
	const out = await execute({
		action: "login",
		domain: "example.com",
		label: "main",
		usernameSelector: "#u",
		passwordSelector: "#p",
	});
	assert.equal(out.isError, true);
	assert.equal(out.details.error, true);
	assert.match(out.content[0].text, /vault/i);
});

test("login dispatches to performLogin using the open handle's cdp, and the secret never leaks into the result", async () => {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const send = async (method: string, params: Record<string, unknown> = {}) => {
		calls.push({ method, params });
		if (method !== "Runtime.evaluate") return {};
		const expression = String(params.expression ?? "");
		if (expression === "location.hostname") return { result: { value: "example.com" } }; // matches req.domain, so the origin-binding gate passes
		if (expression.includes("tagName")) return { result: { value: true } }; // passwordSelector resolves to a real password input
		return { result: { value: { x: 1, y: 1 } } }; // locateCenter's element-position probe
	};
	const fakeManager = { get: () => ({ cdp: { send } }) } as unknown as BrowserManager;
	const vault = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	await vault.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret");
	const confirmedDomains = new Set(["example.com"]);
	const execute = buildBrowserExecute(
		fakeManager,
		{ ORPHUS_ENABLE_BROWSER: "1", ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv,
		vault,
		confirmedDomains,
	);
	const out = await execute({
		action: "login",
		domain: "example.com",
		label: "main",
		usernameSelector: "#u",
		passwordSelector: "#p",
	});
	assert.notEqual(out.isError, true);
	assert.ok(calls.some((c) => c.method === "Input.insertText" && c.params.text === "s3cret"));
	assert.ok(!JSON.stringify(out).includes("s3cret"), "secret must never appear in the tool result");
});

test("wait_for polls the selector and resolves once it appears", async () => {
	let calls = 0;
	const send = async (method: string) => {
		if (method === "Runtime.evaluate") {
			calls += 1;
			return { result: { value: calls >= 2 } }; // absent on the first poll, present on the second
		}
		return {};
	};
	const fakeManager = { get: () => ({ cdp: { send } }) } as unknown as BrowserManager;
	const execute = buildBrowserExecute(fakeManager, { ORPHUS_ENABLE_BROWSER: "1" } as NodeJS.ProcessEnv);
	const out = await execute({ action: "wait_for", selector: "#done" });
	assert.equal(out.isError, undefined);
	assert.match(out.content[0].text, /#done appeared/);
	assert.equal(calls, 2);
});
