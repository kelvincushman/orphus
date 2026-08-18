import type { CredentialCapability, CredentialRecord } from "../../core/capabilities/index.ts";

/**
 * The gate a credential passes before it can reach a page.
 *
 * Three conditions, all required:
 *
 * 1. Login support is enabled (`ORPHUS_ENABLE_BROWSER_LOGIN`, on top of
 *    `ORPHUS_ENABLE_BROWSER`).
 * 2. The page's origin is on the allowlist, and matches the origin the
 *    credential itself is scoped to.
 * 3. A human approved this credential for this origin. Approval is asked once
 *    per session per (label, origin) pair, and is denied when there is no one
 *    to ask.
 *
 * The secret never leaves this module's callers as a value they may log. Only
 * {@link CredentialRecord.label} is safe to disclose; everything this module
 * returns for display is label-only.
 */

export type CredentialDenial =
	| { reason: "login_disabled" }
	| { reason: "origin_not_allowlisted"; origin: string }
	| { reason: "credential_origin_mismatch"; origin: string; credentialOrigin: string }
	| { reason: "unknown_label" }
	| { reason: "approval_denied" }
	| { reason: "no_approver" };

export interface CredentialGrant {
	label: string;
	origin: string;
	username?: string;
	/** The secret. Route it straight to its destination; never log or return it. */
	secret: string;
}

export type CredentialDecision = { ok: true; grant: CredentialGrant } | { ok: false; denial: CredentialDenial };

export function describeDenial(denial: CredentialDenial, label: string): string {
	switch (denial.reason) {
		case "login_disabled":
			return "Browser login is disabled. Set ORPHUS_ENABLE_BROWSER_LOGIN=1 to enable it.";
		case "origin_not_allowlisted":
			return `Refusing to use credential "${label}": ${denial.origin} is not on the browser login allowlist.`;
		case "credential_origin_mismatch":
			return `Refusing to use credential "${label}": it is scoped to ${denial.credentialOrigin}, not ${denial.origin}.`;
		case "unknown_label":
			return `No credential labelled "${label}" is available.`;
		case "approval_denied":
			return `Credential "${label}" was not approved for this origin.`;
		case "no_approver":
			return `Credential "${label}" needs interactive approval, and this session has no one to ask.`;
	}
}

/** Normalize a URL to a comparable `scheme://host[:port]` origin, or undefined. */
export function originOf(url: string): string | undefined {
	try {
		const origin = new URL(url).origin;
		// Opaque origins — file:, data:, custom schemes — all serialize to the
		// string "null". Treating that as an origin would make one allowlist
		// entry match every such page, so it is no origin at all here.
		return origin === "null" ? undefined : origin;
	} catch {
		return undefined;
	}
}

/** Parse `ORPHUS_BROWSER_LOGIN_ORIGINS` into a set of exact origins. */
export function parseOriginAllowlist(value: string | undefined): Set<string> {
	const origins = new Set<string>();
	for (const raw of (value ?? "").split(/[\s,]+/)) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const origin = originOf(trimmed);
		// A bare host is not an origin. Requiring the scheme is what makes
		// `example.com` on the allowlist unable to authorize `http://example.com`.
		if (origin) origins.add(origin);
	}
	return origins;
}

export interface CredentialGateOptions {
	credentials: CredentialCapability;
	loginEnabled: boolean;
	allowlist: Set<string>;
	/** Ask a human. Absent (print mode, a subagent) means the answer is no. */
	approve?: (request: { label: string; origin: string; username?: string }) => Promise<boolean>;
}

export class CredentialGate {
	private readonly options: CredentialGateOptions;
	/** `label\0origin` pairs a human approved in this session. */
	private readonly approved = new Set<string>();

	constructor(options: CredentialGateOptions) {
		this.options = options;
	}

	/** Labels available for this origin. Never includes a secret. */
	async listFor(url: string): Promise<CredentialRecord[]> {
		const origin = originOf(url);
		if (!origin || !this.options.allowlist.has(origin)) return [];
		const all = await this.options.credentials.list();
		return all.filter((record) => record.origin === origin);
	}

	async resolve(label: string, url: string): Promise<CredentialDecision> {
		if (!this.options.loginEnabled) return { ok: false, denial: { reason: "login_disabled" } };
		const origin = originOf(url);
		if (!origin || !this.options.allowlist.has(origin)) {
			return { ok: false, denial: { reason: "origin_not_allowlisted", origin: origin ?? url } };
		}
		const record = (await this.options.credentials.list()).find((entry) => entry.label === label);
		if (!record) return { ok: false, denial: { reason: "unknown_label" } };
		if (record.origin !== origin) {
			return {
				ok: false,
				denial: { reason: "credential_origin_mismatch", origin, credentialOrigin: record.origin },
			};
		}

		const key = `${label}\0${origin}`;
		if (!this.approved.has(key)) {
			if (!this.options.approve) return { ok: false, denial: { reason: "no_approver" } };
			const granted = await this.options.approve({ label, origin, username: record.username });
			if (!granted) return { ok: false, denial: { reason: "approval_denied" } };
			this.approved.add(key);
		}

		// Read the secret last: nothing reveals it until every gate has passed.
		const secret = await this.options.credentials.reveal(label);
		if (secret === undefined) return { ok: false, denial: { reason: "unknown_label" } };
		return { ok: true, grant: { label, origin, username: record.username, secret } };
	}
}
