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

// Defaults mirror the happy path: the live page is on the credential's own domain and
// passwordSelector resolves to a real password input. Tests that need the origin-binding or
// password-field gate to fire override hostname / isPasswordField explicitly.
function cdpRecorder(opts: { hostname?: string; isPasswordField?: boolean } = {}) {
	const hostname = opts.hostname ?? "example.com";
	const isPasswordField = opts.isPasswordField ?? true;
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	return {
		calls,
		send: async (method: string, params: Record<string, unknown> = {}) => {
			calls.push({ method, params });
			if (method !== "Runtime.evaluate") return {};
			const expression = String(params.expression ?? "");
			if (expression === "location.hostname") return { result: { value: hostname } };
			if (expression.includes("tagName")) return { result: { value: isPasswordField } };
			return { result: { value: { x: 1, y: 1 } } }; // locateCenter's element-position probe
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

test("refuses when the live page origin does not match the credential's domain", async () => {
	// Attack scenario: open https://attacker.example, then ask to log in "to" example.com — all
	// three prior gates pass (domain is allowlisted + confirmed), but the page is not actually on
	// that domain, so the credential must never be typed into it.
	const cdp = cdpRecorder({ hostname: "attacker.example" });
	const out = await performLogin(
		{
			vault: await vaultWith(),
			cdp,
			env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv,
			confirmedDomains: new Set(["example.com"]),
		},
		req,
	);
	assert.equal(out.isError, true);
	assert.equal(out.details.error, true);
	assert.match(out.content[0].text, /origin/i);
	assert.ok(
		!cdp.calls.some((c) => c.method === "Input.insertText" && c.params.text === "s3cret"),
		"secret must never be typed when the origin does not match",
	);
	assert.ok(!JSON.stringify(out).includes("s3cret"), "secret must never appear in the tool result");
});

test("accepts a subdomain of the credential's domain", async () => {
	const cdp = cdpRecorder({ hostname: "login.example.com" });
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
	assert.ok(cdp.calls.some((c) => c.method === "Input.insertText" && c.params.text === "s3cret"));
});

test("refuses when passwordSelector does not resolve to a password input", async () => {
	// The model supplies passwordSelector; if it points at a plain text field the model could
	// read the value back with `read` after this call, so the secret must never be typed in.
	const cdp = cdpRecorder({ isPasswordField: false });
	const out = await performLogin(
		{
			vault: await vaultWith(),
			cdp,
			env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv,
			confirmedDomains: new Set(["example.com"]),
		},
		req,
	);
	assert.equal(out.isError, true);
	assert.equal(out.details.error, true);
	assert.match(out.content[0].text, /password/i);
	assert.ok(
		!cdp.calls.some((c) => c.method === "Input.insertText" && c.params.text === "s3cret"),
		"secret must never be typed when the target is not a password field",
	);
	assert.ok(!JSON.stringify(out).includes("s3cret"), "secret must never appear in the tool result");
});
