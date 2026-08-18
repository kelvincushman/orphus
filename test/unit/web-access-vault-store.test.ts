import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserConfigPaths } from "@orphus/coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import { type Credential, CredentialVault } from "../../packages/web-access/credential-vault.js";
import type { SecretBackend } from "../../packages/web-access/vault/keychain.js";
import {
	addToAllowlist,
	createVault,
	linuxStdinRun,
	loadAllowlist,
	persistIndex,
	UnsupportedVaultPlatformError,
} from "../../packages/web-access/vault/vault-store.js";
import { bunExecutable, installBunGlobal } from "../helpers/runtime.js";

// vault-store.ts's Linux RunFn calls Bun.spawn unguarded (same convention as
// packages/web-access/subprocess.ts, which installBunGlobal exists for — see
// its doc comment in test/helpers/runtime.ts).
installBunGlobal();

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "orphus-web-vault-"));
	originalHome = process.env.HOME;
	process.env.HOME = tempHome;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(tempHome, { recursive: true, force: true });
});

function memBackend(): SecretBackend {
	const store = new Map<string, string>();
	return {
		store: async (id, s) => void store.set(id, s),
		lookup: async (id) => store.get(id) ?? null,
		remove: async (id) => void store.delete(id),
	};
}

test("persistIndex then createVault hydrates the same credentials back (cross-session round trip)", async () => {
	const creds: Credential[] = [
		{ domain: "example.com", label: "main", username: "me@example.com" },
		{ domain: "other.test", label: "work", username: "someone" },
	];
	persistIndex(creds);

	const vault = createVault();
	const listed = await vault.list();
	const sortByDomain = (a: Credential, b: Credential) => a.domain.localeCompare(b.domain);
	assert.deepEqual([...listed].sort(sortByDomain), [...creds].sort(sortByDomain));
});

test("addToAllowlist persists a domain that loadAllowlist then returns, idempotently", () => {
	assert.deepEqual(loadAllowlist(), []);
	addToAllowlist("example.com");
	assert.deepEqual(loadAllowlist(), ["example.com"]);
	addToAllowlist("example.com");
	assert.deepEqual(loadAllowlist(), ["example.com"]);
});

test("createVault throws a typed error on a platform with no supported backend", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		assert.throws(() => createVault(), UnsupportedVaultPlatformError);
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
});

test("the persisted index file never contains a secret", async () => {
	const vault = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	await vault.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret-value");

	persistIndex(await vault.list());

	const indexPath = getUserConfigPaths("web-vault-index.json")[0];
	assert.ok(existsSync(indexPath), `expected index file at ${indexPath}`);
	const raw = readFileSync(indexPath, "utf-8");
	assert.ok(!raw.includes("s3cret-value"), "the persisted index must never contain the secret");
	assert.ok(
		raw.includes("example.com") && raw.includes("me@example.com"),
		"the index must still carry the non-secret fields",
	);
});

test("the persisted allowlist file never contains a secret", () => {
	addToAllowlist("example.com");
	const allowlistPath = getUserConfigPaths("web-vault-allowlist.json")[0];
	const raw = readFileSync(allowlistPath, "utf-8");
	assert.ok(!raw.includes("s3cret"));
	assert.ok(raw.includes("example.com"));
});

test("linuxStdinRun pipes the payload to the child over stdin rather than argv", async () => {
	const result = await linuxStdinRun(
		bunExecutable(),
		["-e", "process.stdout.write(await Bun.stdin.text())"],
		"s3cret-value",
	);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "s3cret-value");
});

test("linuxStdinRun runs without stdin when none is given", async () => {
	const result = await linuxStdinRun(bunExecutable(), ["-e", "process.stdout.write('ok')"]);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "ok");
});
