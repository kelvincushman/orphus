import { getUserConfigPaths } from "@orphus/coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CredentialVault, type Credential } from "../credential-vault.js";
import { findReadableConfigPath } from "../config-paths.ts";
import { linuxSecretTool, macosKeychain, type RunFn, type SecretBackend } from "./keychain.js";

const INDEX_FILENAME = "web-vault-index.json";
const ALLOWLIST_FILENAME = "web-vault-allowlist.json";
const AUDIT_LOG_FILENAME = "web-vault-audit.log";

/** Thrown by {@link createVault} on a platform with no supported secret backend. */
export class UnsupportedVaultPlatformError extends Error {
	constructor(platform: string) {
		super(`No credential vault backend is available for platform "${platform}" (supported: darwin, linux).`);
		this.name = "UnsupportedVaultPlatformError";
	}
}

// Resolved fresh on every call (never cached at module scope) so a test can
// point HOME at a temp directory before calling any exported function here.
function indexPaths(): string[] {
	return getUserConfigPaths(INDEX_FILENAME);
}
function allowlistPaths(): string[] {
	return getUserConfigPaths(ALLOWLIST_FILENAME);
}
function auditLogPath(): string {
	return getUserConfigPaths(AUDIT_LOG_FILENAME)[0];
}

function ensureDirFor(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonArray(path: string): unknown[] {
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeJson(path: string, data: unknown): void {
	ensureDirFor(path);
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Record<string, unknown>;
	return typeof c.domain === "string" && typeof c.label === "string" && typeof c.username === "string";
}

/**
 * Load the persisted domain allowlist. NON-secret: a flat JSON array of domain
 * strings. Missing or unreadable file reads as an empty allowlist.
 */
export function loadAllowlist(): string[] {
	const path = findReadableConfigPath(allowlistPaths());
	return readJsonArray(path).filter((v): v is string => typeof v === "string");
}

/** Add a domain to the persisted allowlist (no-op if already present). */
export function addToAllowlist(domain: string): void {
	const current = loadAllowlist();
	if (current.includes(domain)) return;
	writeJson(allowlistPaths()[0], [...current, domain]);
}

function loadIndex(): Credential[] {
	const path = findReadableConfigPath(indexPaths());
	return readJsonArray(path).filter(isCredential);
}

/**
 * Persist the NON-secret credential index (domain, label, username only — never
 * the secret, which lives solely in the OS keychain) so it survives a restart.
 */
export function persistIndex(creds: Credential[]): void {
	writeJson(indexPaths()[0], creds);
}

function appendAuditLine(line: string): void {
	const path = auditLogPath();
	ensureDirFor(path);
	appendFileSync(path, line + "\n");
}

/**
 * Linux `secret-tool store` reads the secret on stdin, not argv. The default
 * `RunFn` (`runBunSubprocess` via keychain.ts) spawns with `stdin: "ignore"`, so
 * it cannot deliver one. This is a small, dedicated `RunFn` that pipes `stdin`
 * into the child via `Bun.spawn` instead. Unused on darwin, where Task 6's
 * `security` backend passes the secret via `-w` argv.
 *
 * Like `packages/web-access/subprocess.ts`, this calls `Bun.spawn` unguarded:
 * this module only ever runs inside the Bun-compiled binary.
 */
export const linuxStdinRun: RunFn = async (cmd, args, stdin) => {
	const proc = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
	if (stdin !== undefined) {
		proc.stdin.write(stdin);
		await proc.stdin.end();
	}
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { stdout: stdout.replace(/\n$/, ""), code };
};

function selectBackend(): SecretBackend {
	if (process.platform === "darwin") return macosKeychain();
	if (process.platform === "linux") return linuxSecretTool(linuxStdinRun);
	throw new UnsupportedVaultPlatformError(process.platform);
}

/**
 * Construct the one shared credential vault: picks the real OS keychain backend
 * for the current platform, loads the persisted (non-secret) allowlist and
 * index from disk, hydrates the vault's in-memory index from them, and wires
 * audit lines to append to the on-disk audit log. The secret itself is never
 * read here — it stays in the backend until `injectInto` asks for it.
 */
export function createVault(): CredentialVault {
	const vault = new CredentialVault(selectBackend(), { allowlist: loadAllowlist(), audit: appendAuditLine });
	vault.hydrate(loadIndex());
	return vault;
}
