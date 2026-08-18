import assert from "node:assert/strict";
import { test } from "vitest";
import { performLogin } from "../../packages/web-access/browser-login.js";
import { CredentialVault } from "../../packages/web-access/credential-vault.js";
import type { SecretBackend } from "../../packages/web-access/vault/keychain.js";

function memBackend(): SecretBackend {
	const m = new Map<string, string>();
	return {
		store: async (id, s) => void m.set(id, s),
		lookup: async (id) => m.get(id) ?? null,
		remove: async (id) => void m.delete(id),
	};
}

function cdpRecorder() {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	return {
		calls,
		send: async (method: string, params: Record<string, unknown> = {}) => {
			calls.push({ method, params });
			return method === "Runtime.evaluate" ? { result: { value: { x: 1, y: 1 } } } : {};
		},
	};
}

async function vaultWith(): Promise<CredentialVault> {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	await v.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret");
	return v;
}

const req = { domain: "example.com", label: "main", usernameSelector: "#u", passwordSelector: "#p" };

test("refuses when the login flag is off", async () => {
	const out = await performLogin(
		{
			vault: await vaultWith(),
			cdp: cdpRecorder(),
			env: {} as NodeJS.ProcessEnv,
			confirmedDomains: new Set(["example.com"]),
		},
		req,
	);
	assert.equal(out.isError, true);
	assert.equal(out.details.error, true);
	assert.match(out.content[0].text, /ORPHUS_ENABLE_BROWSER_LOGIN/);
});

test("refuses an off-allowlist domain", async () => {
	const v = new CredentialVault(memBackend(), { allowlist: [] });
	const out = await performLogin(
		{
			vault: v,
			cdp: cdpRecorder(),
			env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv,
			confirmedDomains: new Set(["example.com"]),
		},
		req,
	);
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /allowlist/i);
});

test("refuses an unconfirmed first use", async () => {
	const out = await performLogin(
		{
			vault: await vaultWith(),
			cdp: cdpRecorder(),
			env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv,
			confirmedDomains: new Set(),
		},
		req,
	);
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /confirm/i);
});

test("fills the fields and never returns the secret", async () => {
	const cdp = cdpRecorder();
	const out = await performLogin(
		{
			vault: await vaultWith(),
			cdp,
			env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv,
			confirmedDomains: new Set(["example.com"]),
		},
		req,
	);
	assert.notEqual(out.isError, true);
	assert.ok(
		cdp.calls.some((c) => c.method === "Input.insertText" && c.params.text === "s3cret"),
		"secret is typed into the field",
	);
	assert.ok(
		cdp.calls.some((c) => c.method === "Input.insertText" && c.params.text === "me@example.com"),
		"username is typed into its own field",
	);
	assert.ok(!JSON.stringify(out).includes("s3cret"), "secret must never appear in the tool result");
});
