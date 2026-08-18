import type { SecretBackend } from "./vault/keychain.js";

export interface Credential {
	domain: string;
	label: string;
	username: string;
}

export interface CredentialVaultOptions {
	allowlist: string[];
	audit?: (line: string) => void;
}

const idOf = (domain: string, label: string): string => `${domain}:${label}`;

/**
 * CredentialVault is the sole boundary between stored secrets and the rest of the
 * agent. Secrets never leave the vault as a return value: `injectInto` is the only
 * read path, and it streams the secret directly into a caller-supplied sink (the
 * CDP field-filler) rather than handing it back. Every other public method deals
 * only in non-secret data (domain, label, username).
 */
export class CredentialVault {
	private readonly index = new Map<string, Credential>();
	private readonly audit: (line: string) => void;

	constructor(
		private readonly backend: SecretBackend,
		private readonly opts: CredentialVaultOptions,
	) {
		this.audit = opts.audit ?? (() => {});
	}

	isAllowed(domain: string): boolean {
		return this.opts.allowlist.includes(domain);
	}

	async set(cred: Credential, secret: string): Promise<void> {
		await this.backend.store(idOf(cred.domain, cred.label), secret);
		this.index.set(idOf(cred.domain, cred.label), cred);
		this.audit(`${new Date().toISOString()} set ${cred.domain} ${cred.label} (${cred.username})`);
	}

	async list(): Promise<Credential[]> {
		return [...this.index.values()];
	}

	async remove(domain: string, label: string): Promise<void> {
		await this.backend.remove(idOf(domain, label));
		this.index.delete(idOf(domain, label));
		this.audit(`${new Date().toISOString()} remove ${domain} ${label}`);
	}

	/**
	 * Seeds the in-memory index from persisted NON-secret records (domain, label,
	 * username) without touching the secret backend and without writing an audit
	 * line. This is how the index is rebuilt across sessions: the keychain holds
	 * the secret, a JSON file on disk holds this non-secret index, and the wiring
	 * that constructs the vault calls this once at startup to repopulate it.
	 */
	hydrate(creds: Credential[]): void {
		for (const cred of creds) this.index.set(idOf(cred.domain, cred.label), cred);
	}

	/**
	 * Returns the stored (non-secret) username for a credential, or null if none is
	 * stored. Pure and synchronous: it reads only the in-memory index and never
	 * touches the secret backend. Lets a caller (e.g. login flow) type the username
	 * into its own field before the secret sink runs via injectInto.
	 */
	usernameFor(domain: string, label: string): string | null {
		return this.index.get(idOf(domain, label))?.username ?? null;
	}

	/**
	 * The only read path for a stored secret. Hands the secret to `sink` (the CDP
	 * field-filler) and returns only the username — never the secret itself. There is
	 * no method on this class that returns a secret value.
	 */
	async injectInto(domain: string, label: string, sink: (secret: string) => Promise<void>): Promise<{ username: string }> {
		const cred = this.index.get(idOf(domain, label));
		if (!cred) {
			const e = new Error(`no credential for ${domain}/${label}`);
			e.name = "CredentialMiss";
			throw e;
		}
		const secret = await this.backend.lookup(idOf(domain, label));
		if (secret === null) {
			const e = new Error(`keychain miss for ${domain}/${label}`);
			e.name = "CredentialMiss";
			throw e;
		}
		await sink(secret);
		this.audit(`${new Date().toISOString()} inject ${domain} ${label} (${cred.username})`);
		return { username: cred.username };
	}
}
