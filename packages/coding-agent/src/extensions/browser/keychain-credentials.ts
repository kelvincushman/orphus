import type {
	CredentialCapability,
	CredentialRecord,
	FileSystemCapability,
	ProcessCapability,
} from "../../core/capabilities/index.ts";

/**
 * Browser credentials, split across two stores by sensitivity.
 *
 * The **secret** lives in the OS keychain and is never read except at the
 * moment it is handed to CDP: `security` on macOS, `secret-tool` (libsecret) on
 * Linux. Nothing in Orphus writes it, caches it, or copies it to disk.
 *
 * The **metadata** — which labels exist, which origin each is scoped to, and an
 * optional username — is not secret and needs to be enumerable without touching
 * the keychain, so it lives in an owner-only JSON registry beside the agent
 * config. That split is what lets `list()` answer "which credentials could
 * apply to this page" without a single keychain read, and keeps the origin
 * binding under Orphus's control rather than parsed out of a keychain comment.
 *
 * Windows has no equivalent CLI shipped in the OS, so this vault reports itself
 * unavailable there and browser login fails closed, which is the correct answer
 * until a native binding exists.
 */

/** Keychain service name every Orphus browser credential is filed under. */
export const KEYCHAIN_SERVICE = "orphus-browser";

/** Filename of the non-secret registry, relative to the agent directory. */
export const CREDENTIAL_REGISTRY_FILE = "browser-credentials.json";

interface RegistryEntry {
	label: string;
	origin: string;
	username?: string;
}

export interface KeychainCredentialOptions {
	processes: ProcessCapability;
	fs: FileSystemCapability;
	/** Absolute path to the non-secret registry. */
	registryPath: string;
	platform?: NodeJS.Platform;
	/** A locked keychain prompts a human who may not be there. Default 5s. */
	lookupTimeoutMs?: number;
}

export function keychainLookupCommand(
	label: string,
	platform: NodeJS.Platform,
): { command: string; args: string[] } | undefined {
	if (platform === "darwin") {
		return { command: "security", args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", label, "-w"] };
	}
	if (platform === "linux") {
		return { command: "secret-tool", args: ["lookup", "service", KEYCHAIN_SERVICE, "account", label] };
	}
	return undefined;
}

function parseRegistry(raw: string): RegistryEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const valid = parsed.filter((entry): entry is RegistryEntry => {
		if (typeof entry !== "object" || entry === null) return false;
		const candidate = entry as Partial<RegistryEntry>;
		if (typeof candidate.label !== "string" || typeof candidate.origin !== "string") return false;
		// The username is typed into a page verbatim; a non-string would land as
		// "[object Object]" in a login form.
		return candidate.username === undefined || typeof candidate.username === "string";
	});
	// The label is the key — it is what `reveal` hands to the keychain, which
	// holds one secret per label. A duplicate row cannot name a second secret,
	// so the first occurrence wins and later ones are dropped.
	const byLabel = new Map<string, RegistryEntry>();
	for (const entry of valid) {
		if (!byLabel.has(entry.label)) byLabel.set(entry.label, entry);
	}
	return [...byLabel.values()];
}

/**
 * The OS-keychain credential capability.
 *
 * `reveal` returns the secret and nothing else knows it was read. A missing
 * keychain tool, a missing entry, or a non-zero exit all resolve to
 * `undefined`: an unreadable credential must look exactly like an absent one,
 * so a caller cannot distinguish "wrong label" from "no keychain" and neither
 * leaks into a message.
 */
export function createKeychainCredentials(options: KeychainCredentialOptions): CredentialCapability {
	const platform = options.platform ?? process.platform;
	return {
		kind: platform === "darwin" ? "macos-keychain" : platform === "linux" ? "libsecret" : "unavailable",
		async list(): Promise<CredentialRecord[]> {
			if (!keychainLookupCommand("probe", platform)) return [];
			let raw: string;
			try {
				raw = await options.fs.readFile(options.registryPath);
			} catch {
				return [];
			}
			return parseRegistry(raw).map(({ label, origin, username }) => ({
				label,
				origin,
				...(username ? { username } : {}),
			}));
		},
		async reveal(label: string): Promise<string | undefined> {
			const lookup = keychainLookupCommand(label, platform);
			if (!lookup) return undefined;
			// Bounded: `security` and `secret-tool` block on an unlock prompt when
			// the keychain is locked, and on a headless machine nobody answers. An
			// aborted lookup resolves with a non-zero code, which the guard below
			// already treats as "indistinguishable from absent".
			const result = await options.processes.exec(lookup.command, lookup.args, {
				signal: AbortSignal.timeout(options.lookupTimeoutMs ?? 5_000),
			});
			if (result.code !== 0) return undefined;
			const secret = result.stdout.replace(/\r?\n$/, "");
			return secret.length > 0 ? secret : undefined;
		},
	};
}
