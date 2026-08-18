import assert from "node:assert/strict";
import { test } from "vitest";
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

test("injectInto delivers the secret to the sink and returns only the username", async () => {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	await v.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret");
	let delivered = "";
	const out = await v.injectInto("example.com", "main", async (secret) => {
		delivered = secret;
	});
	assert.equal(delivered, "s3cret");
	assert.equal(out.username, "me@example.com");
	// the returned object must not carry the secret anywhere
	assert.ok(!JSON.stringify(out).includes("s3cret"));
});

test("the vault exposes no method that returns a secret", () => {
	const v = new CredentialVault(memBackend(), { allowlist: [] });
	assert.equal((v as unknown as { getSecret?: unknown }).getSecret, undefined);
});

test("isAllowed enforces the domain allowlist", () => {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	assert.equal(v.isAllowed("example.com"), true);
	assert.equal(v.isAllowed("evil.test"), false);
});

test("set writes an audit line", async () => {
	const lines: string[] = [];
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"], audit: (l) => lines.push(l) });
	// secret is "s3cret", not "x": "example.com" itself contains the letter "x" ("e-x-ample"),
	// so asserting both "includes domain" and "excludes secret" is unsatisfiable if the secret is "x".
	await v.set({ domain: "example.com", label: "main", username: "me" }, "s3cret");
	assert.ok(lines.some((l) => l.includes("set") && l.includes("example.com") && !l.includes("s3cret")));
});

test("usernameFor returns the stored username without touching the secret backend", async () => {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	await v.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret");
	assert.equal(v.usernameFor("example.com", "main"), "me@example.com");
});

test("usernameFor returns null for an unknown credential", () => {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	assert.equal(v.usernameFor("example.com", "unknown"), null);
});

test("hydrate seeds the in-memory index without touching the backend or writing audit", async () => {
	const lines: string[] = [];
	const backend = memBackend();
	let storeCalls = 0;
	const countingBackend: SecretBackend = {
		store: async (id, s) => {
			storeCalls += 1;
			await backend.store(id, s);
		},
		lookup: backend.lookup,
		remove: backend.remove,
	};
	const v = new CredentialVault(countingBackend, { allowlist: ["example.com"], audit: (l) => lines.push(l) });
	v.hydrate([{ domain: "example.com", label: "main", username: "me@example.com" }]);
	assert.equal(v.usernameFor("example.com", "main"), "me@example.com");
	assert.deepEqual(await v.list(), [{ domain: "example.com", label: "main", username: "me@example.com" }]);
	assert.equal(storeCalls, 0, "hydrate must not call the secret backend");
	assert.deepEqual(lines, [], "hydrate must not write an audit line");
	// the secret backend has no entry, so a hydrated credential's secret is
	// still a genuine keychain miss until something actually calls set()
	await assert.rejects(
		v.injectInto("example.com", "main", async () => {}),
		(error: Error) => error.name === "CredentialMiss",
	);
});
