import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ClockCapability, FileSystemCapability } from "./capabilities/index.ts";

/** Custom session entry type for the exact request delivered to a provider. */
export const PROVIDER_REQUEST_ENTRY = "orphus.provider.request.v1";
/** Custom session entry type for what came back from that request. */
export const PROVIDER_RESPONSE_ENTRY = "orphus.provider.response.v1";

/** Bodies at or under this size are stored inline; larger ones spill to an artifact. */
export const MAX_INLINE_BODY_BYTES = 1_048_576;

/** Directory, relative to the session directory, holding spilled request bodies. */
export const PROVIDER_REQUEST_SPILL_DIR = "provider-requests";

/** Set to `0` to stop recording provider bodies. Recording is on by default. */
export const ENV_PROVIDER_AUDIT = "ORPHUS_PROVIDER_AUDIT";

/**
 * Keys whose values are never written to disk even when a provider payload
 * carries them. Credentials normally travel in headers, which this recorder
 * never sees — this is the second line, for a payload that carries one anyway.
 */
const CREDENTIAL_KEY_PATTERN = /(^|[._-])(api[._-]?key|authorization|auth|secret|token|password|credential)s?$/i;

export const REDACTED = "[redacted]";

export interface ProviderRequestRecord {
	/** Unique per dispatched request; the join key for the response record. */
	requestId: string;
	/** 0 for a turn's first dispatch, incremented for each retry before a completed response. */
	attempt: number;
	/** Ordinal of the logical turn within this session's recording. */
	turn: number;
	/** Session-tree leaf at dispatch — the branch this request was issued on. */
	branchLeafId: string | null;
	provider: string;
	model: string;
	api: string;
	/** SHA-256 of the exact body delivered to the provider, before any redaction. */
	sha256: string;
	/** Byte length of that exact body. */
	byteLength: number;
	/** The body itself, when it fits inline. */
	body?: string;
	/** Session-relative path to the spilled body, when it does not. */
	bodyPath?: string;
	/**
	 * Property paths replaced with {@link REDACTED} in the stored body. Empty
	 * for the overwhelming majority of requests. When non-empty the stored body
	 * deliberately differs from `sha256`, which always describes what was sent.
	 */
	redactedPaths?: string[];
	timestamp: number;
}

export interface ProviderResponseRecord {
	requestId: string;
	attempt: number;
	turn: number;
	/** HTTP status, when the transport reported one. */
	status?: number;
	/** Provider stop reason, e.g. `stop`, `toolUse`, `length`, `error`, `aborted`. */
	finishReason?: string;
	usage?: Usage;
	/** Milliseconds from dispatch to settlement, on the monotonic clock. */
	durationMs: number;
	error?: NormalizedProviderError;
	timestamp: number;
}

export interface NormalizedProviderError {
	kind: "auth" | "rate_limit" | "overloaded" | "context_overflow" | "network" | "aborted" | "provider" | "unknown";
	message: string;
	status?: number;
}

/** The slice of SessionManager the recorder needs. Keeps the recorder testable. */
export interface ProviderAuditSessionSink {
	appendCustomEntry(customType: string, data?: unknown): string;
	getSessionDir(): string | null;
	getLeafId(): string | null;
}

export interface ProviderAuditRecorderOptions {
	session: ProviderAuditSessionSink;
	fs: FileSystemCapability;
	clock: ClockCapability;
	/** Defaults to `randomUUID`. Overridden for deterministic replay. */
	newRequestId?: () => string;
	enabled?: boolean;
}

/** Map a thrown provider failure onto a small, stable vocabulary. */
export function normalizeProviderError(error: unknown, status?: number): NormalizedProviderError {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	const kind: NormalizedProviderError["kind"] = (() => {
		if (status === 401 || status === 403 || lower.includes("api key") || lower.includes("unauthorized"))
			return "auth";
		if (status === 429 || lower.includes("rate limit")) return "rate_limit";
		if (status === 529 || lower.includes("overloaded")) return "overloaded";
		if (lower.includes("context") && (lower.includes("length") || lower.includes("window")))
			return "context_overflow";
		if (lower.includes("abort")) return "aborted";
		if (lower.includes("econnreset") || lower.includes("fetch failed") || lower.includes("socket")) return "network";
		if (status !== undefined && status >= 400) return "provider";
		return "unknown";
	})();
	return { kind, message, ...(status === undefined ? {} : { status }) };
}

/** Deep-clone `value`, replacing credential-shaped leaves. Returns the paths it touched. */
export function redactCredentialFields(value: unknown): { value: unknown; redactedPaths: string[] } {
	const redactedPaths: string[] = [];
	const walk = (node: unknown, path: string): unknown => {
		if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
		if (node === null || typeof node !== "object") return node;
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
			const childPath = path ? `${path}.${key}` : key;
			// Strings and containers under a credential-shaped key go, wholesale:
			// `authorization: { value: "…" }` is still a credential, and
			// over-redacting a container is safe where recursing past it is not.
			// Numbers and booleans stay — a secret is never a number, and
			// `max_tokens` matches the key pattern in nearly every real payload.
			const credentialShaped =
				CREDENTIAL_KEY_PATTERN.test(key) &&
				(typeof item === "string" || (typeof item === "object" && item !== null));
			if (credentialShaped) {
				redactedPaths.push(childPath);
				result[key] = REDACTED;
				continue;
			}
			result[key] = walk(item, childPath);
		}
		return result;
	};
	return { value: walk(value, ""), redactedPaths };
}

/** The canonical serialization of a payload — what the provider receives on the wire. */
export function serializeProviderBody(payload: unknown): string {
	return JSON.stringify(payload) ?? "null";
}

export function sha256Hex(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Writes `orphus.provider.request.v1` / `orphus.provider.response.v1` entries.
 *
 * Turn and attempt identity is derived here rather than read from the session:
 * a request that follows a completed response opens a new turn at attempt 0, and
 * a request that follows an errored or abandoned one is the next attempt of the
 * same turn. That is exactly the correlation a replay needs, and it keeps the
 * recorder self-contained instead of mirroring a counter that lives elsewhere.
 */
export class ProviderAuditRecorder {
	private readonly session: ProviderAuditSessionSink;
	private readonly fs: FileSystemCapability;
	private readonly clock: ClockCapability;
	private readonly newRequestId: () => string;
	readonly enabled: boolean;
	private turn = 0;
	private attempt = 0;
	private pending:
		| { requestId: string; attempt: number; turn: number; startedAt: number; status?: number }
		| undefined;

	constructor(options: ProviderAuditRecorderOptions) {
		this.session = options.session;
		this.fs = options.fs;
		this.clock = options.clock;
		this.newRequestId = options.newRequestId ?? randomUUID;
		this.enabled = options.enabled ?? true;
	}

	/**
	 * Persist the exact body about to be dispatched.
	 *
	 * Throws when the record cannot be written. Callers must let that propagate:
	 * a dispatch whose request was not recorded is a dispatch nothing can replay,
	 * so the attempt fails before it reaches the network.
	 */
	async recordRequest(input: { payload: unknown; provider: string; model: string; api: string }): Promise<string> {
		const requestId = this.newRequestId();
		if (!this.enabled) return requestId;
		const body = serializeProviderBody(input.payload);
		const byteLength = Buffer.byteLength(body, "utf8");
		const sha256 = sha256Hex(body);
		const { value: redactedPayload, redactedPaths } = redactCredentialFields(input.payload);
		const storedBody = redactedPaths.length > 0 ? serializeProviderBody(redactedPayload) : body;

		const record: ProviderRequestRecord = {
			requestId,
			attempt: this.attempt,
			turn: this.turn,
			branchLeafId: this.session.getLeafId(),
			provider: input.provider,
			model: input.model,
			api: input.api,
			sha256,
			byteLength,
			timestamp: this.clock.now(),
			...(redactedPaths.length > 0 ? { redactedPaths } : {}),
		};

		if (Buffer.byteLength(storedBody, "utf8") <= MAX_INLINE_BODY_BYTES) {
			record.body = storedBody;
		} else {
			record.bodyPath = await this.spillBody(requestId, storedBody);
		}

		this.session.appendCustomEntry(PROVIDER_REQUEST_ENTRY, record);
		this.pending = { requestId, attempt: this.attempt, turn: this.turn, startedAt: this.clock.monotonicNow() };
		return requestId;
	}

	/** Attach the transport status to the in-flight request. */
	noteResponseStatus(status: number): void {
		if (this.pending) this.pending.status = status;
	}

	/**
	 * Close out the in-flight request. A finish reason other than `error` or
	 * `aborted` completes the turn; anything else leaves it open so the next
	 * request records as the following attempt.
	 */
	recordResponse(input: { finishReason?: string; usage?: Usage; error?: unknown }): void {
		const pending = this.pending;
		this.pending = undefined;
		// Only a correlated response advances the turn/attempt identity: a
		// response with no recorded request (recording disabled, or a dispatch
		// path that bypasses `recordRequest`) must not shift every later record.
		if (!pending) return;
		const failed = input.error !== undefined || input.finishReason === "error" || input.finishReason === "aborted";
		if (failed) this.attempt += 1;
		else {
			this.turn += 1;
			this.attempt = 0;
		}
		if (!this.enabled) return;
		const record: ProviderResponseRecord = {
			requestId: pending.requestId,
			attempt: pending.attempt,
			turn: pending.turn,
			durationMs: this.clock.monotonicNow() - pending.startedAt,
			timestamp: this.clock.now(),
			...(pending.status === undefined ? {} : { status: pending.status }),
			...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
			...(input.usage === undefined ? {} : { usage: input.usage }),
			...(input.error === undefined ? {} : { error: normalizeProviderError(input.error, pending.status) }),
		};
		this.session.appendCustomEntry(PROVIDER_RESPONSE_ENTRY, record);
	}

	/**
	 * Spill an oversized body into an owner-only artifact and return the path
	 * relative to the session directory, which is what the record carries.
	 */
	private async spillBody(requestId: string, body: string): Promise<string> {
		// The id becomes a path component and `newRequestId` is injectable; an id
		// carrying a separator or traversal must not choose where the body lands.
		if (!/^[A-Za-z0-9._-]+$/.test(requestId) || requestId.includes("..")) {
			throw new Error(`Cannot spill provider request body: "${requestId}" is not a safe path component.`);
		}
		const sessionDir = this.session.getSessionDir();
		if (!sessionDir) {
			throw new Error(
				`Cannot record provider request ${requestId}: body exceeds ${MAX_INLINE_BODY_BYTES} bytes and this session has no directory to spill into.`,
			);
		}
		const relativePath = `${PROVIDER_REQUEST_SPILL_DIR}/${requestId}.json`;
		await this.fs.mkdir(join(sessionDir, PROVIDER_REQUEST_SPILL_DIR), { recursive: true, mode: 0o700 });
		await this.fs.writeFile(join(sessionDir, relativePath), body, { mode: 0o600 });
		return relativePath;
	}
}

/** Read the recording switch from the environment. Recording is on unless explicitly disabled. */
export function isProviderAuditEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env[ENV_PROVIDER_AUDIT]?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}
