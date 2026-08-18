import {
	type CaptureDevice,
	encodeMessage,
	JsonLinesDecoder,
	type NativeIdentity,
	parseResponse,
	TRANSCRIBE_PROTOCOL_VERSION,
	type TranscribeRequest,
	type TranscribeResponse,
	verifyNativeIdentity,
} from "./protocol.ts";

/**
 * A duplex line channel to a backend.
 *
 * The Bun-FFI worker and the helper executable differ only in what implements
 * this: `postMessage`/`onmessage` in one case, stdin/stdout pipes in the other.
 * Everything above this line is shared, so the fallback path is exercised by the
 * same tests as the primary one.
 */
export interface BackendChannel {
	readonly kind: "worker" | "helper" | "fake";
	send(line: string): void;
	onLine(listener: (line: string) => void): void;
	/** The channel went away on its own — a crashed worker, an exited helper. */
	onClose(listener: (reason: string) => void): void;
	close(): void | Promise<void>;
}

export interface Transcript {
	text: string;
	language?: string;
	durationMs?: number;
}

export interface InitializeOptions {
	modelPath: string;
	language: string;
	sampleRate: number;
	/** Reject the backend unless it reports this build. Omit to check only the ABI version. */
	expectedBuildHash?: string;
}

export interface TranscriptionBackend {
	readonly kind: BackendChannel["kind"];
	readonly native: NativeIdentity | undefined;
	initialize(options: InitializeOptions): Promise<void>;
	listDevices(): Promise<CaptureDevice[]>;
	startRecording(device?: string): Promise<void>;
	stopAndTranscribe(): Promise<Transcript>;
	cancel(): Promise<void>;
	dispose(): Promise<void>;
	/** Input level updates for the recording meter. Returns an unsubscribe function. */
	onLevel(listener: (level: number) => void): () => void;
}

/** How long `dispose` waits for the backend's acknowledgement before moving on. */
export const DISPOSE_ACK_TIMEOUT_MS = 2_000;

export class TranscribeBackendError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "TranscribeBackendError";
		this.code = code;
	}
}

interface Pending {
	resolve: (response: TranscribeResponse) => void;
	reject: (error: Error) => void;
}

/**
 * The protocol client. One instance owns one backend for its whole life.
 *
 * Requests are correlated by id and every in-flight one is rejected when the
 * channel dies, so a crashed worker surfaces as a failed request rather than a
 * promise that never settles.
 */
export class ProtocolBackend implements TranscriptionBackend {
	readonly kind: BackendChannel["kind"];
	private readonly channel: BackendChannel;
	private readonly decoder = new JsonLinesDecoder();
	private readonly pending = new Map<string, Pending>();
	private readonly levelListeners = new Set<(level: number) => void>();
	private nativeIdentity: NativeIdentity | undefined;
	private closedReason: string | undefined;
	private nextId = 1;

	constructor(channel: BackendChannel) {
		this.channel = channel;
		this.kind = channel.kind;
		channel.onLine((line) => this.handleLine(line));
		channel.onClose((reason) => this.handleClose(reason));
	}

	get native(): NativeIdentity | undefined {
		return this.nativeIdentity;
	}

	async initialize(options: InitializeOptions): Promise<void> {
		const response = await this.request({
			kind: "initialize",
			id: this.newId(),
			modelPath: options.modelPath,
			language: options.language,
			sampleRate: options.sampleRate,
		});
		if (response.kind !== "ready") throw this.unexpected("initialize", response);
		if (response.protocolVersion !== TRANSCRIBE_PROTOCOL_VERSION) {
			throw new TranscribeBackendError(
				"protocol_error",
				`Backend speaks protocol ${response.protocolVersion}; this build speaks ${TRANSCRIBE_PROTOCOL_VERSION}.`,
			);
		}
		const check = verifyNativeIdentity(response.native, { buildHash: options.expectedBuildHash });
		if (!check.ok) throw new TranscribeBackendError("abi_mismatch", `Refusing the backend: ${check.reason}.`);
		this.nativeIdentity = response.native;
	}

	async listDevices(): Promise<CaptureDevice[]> {
		const response = await this.request({ kind: "listDevices", id: this.newId() });
		if (response.kind !== "devices") throw this.unexpected("listDevices", response);
		return response.devices;
	}

	async startRecording(device?: string): Promise<void> {
		const response = await this.request({
			kind: "startRecording",
			id: this.newId(),
			...(device === undefined ? {} : { device }),
		});
		if (response.kind !== "recording") throw this.unexpected("startRecording", response);
	}

	async stopAndTranscribe(): Promise<Transcript> {
		const response = await this.request({ kind: "stopAndTranscribe", id: this.newId() });
		if (response.kind === "cancelled") throw new TranscribeBackendError("cancelled", "Transcription was cancelled.");
		if (response.kind !== "transcript") throw this.unexpected("stopAndTranscribe", response);
		return {
			text: response.text,
			...(response.language === undefined ? {} : { language: response.language }),
			...(response.durationMs === undefined ? {} : { durationMs: response.durationMs }),
		};
	}

	async cancel(): Promise<void> {
		const response = await this.request({ kind: "cancel", id: this.newId() });
		if (response.kind !== "cancelled") throw this.unexpected("cancel", response);
	}

	async dispose(): Promise<void> {
		if (!this.closedReason) {
			// Best effort, and bounded: a backend that has already died owes us
			// nothing, and one that answers `ready` but ignores `dispose` must not
			// hang teardown — the fallback ladder is waiting behind this await.
			const acknowledged = this.request({ kind: "dispose", id: this.newId() }).catch(() => undefined);
			await Promise.race([
				acknowledged,
				new Promise<void>((resolve) => {
					setTimeout(resolve, DISPOSE_ACK_TIMEOUT_MS).unref?.();
				}),
			]);
		}
		this.handleClose("disposed");
		await this.channel.close();
	}

	onLevel(listener: (level: number) => void): () => void {
		this.levelListeners.add(listener);
		return () => {
			this.levelListeners.delete(listener);
		};
	}

	private newId(): string {
		return String(this.nextId++);
	}

	private request(message: TranscribeRequest): Promise<TranscribeResponse> {
		if (this.closedReason) {
			return Promise.reject(new TranscribeBackendError("internal", `Backend unavailable: ${this.closedReason}`));
		}
		return new Promise<TranscribeResponse>((resolve, reject) => {
			this.pending.set(message.id, { resolve, reject });
			this.channel.send(encodeMessage(message));
		});
	}

	private unexpected(request: string, response: TranscribeResponse): Error {
		if (response.kind === "error") return new TranscribeBackendError(response.code, response.message);
		return new TranscribeBackendError("protocol_error", `${request} answered with an unexpected "${response.kind}".`);
	}

	private handleLine(line: string): void {
		const { messages, errors } = this.decoder.push(line);
		// A line that is not a protocol message is a backend to stop trusting,
		// not one to keep reading past: close it, which rejects everything
		// in flight and lets the fallback ladder try the next channel.
		for (const raw of errors) this.protocolViolation(`unparsable line: ${raw}`);
		for (const message of messages) {
			const response = parseResponse(message);
			if (!response) {
				this.protocolViolation(`invalid message: ${JSON.stringify(message)?.slice(0, 200)}`);
				continue;
			}
			if (response.kind === "level") {
				for (const listener of [...this.levelListeners]) listener(response.level);
				continue;
			}
			const id = response.id;
			if (id === undefined) {
				// An error with no id belongs to no request; it kills the backend.
				if (response.kind === "error") this.failAll(new TranscribeBackendError(response.code, response.message));
				continue;
			}
			const pending = this.pending.get(id);
			if (!pending) continue;
			this.pending.delete(id);
			pending.resolve(response);
		}
	}

	private handleClose(reason: string): void {
		if (this.closedReason) return;
		this.closedReason = reason;
		this.failAll(new TranscribeBackendError("internal", `Backend stopped: ${reason}`));
		this.levelListeners.clear();
	}

	/** A malformed message is terminal: mark the backend closed and drop the channel. */
	private protocolViolation(detail: string): void {
		if (this.closedReason) return;
		this.handleClose(`protocol violation: ${detail}`);
		void Promise.resolve(this.channel.close()).catch(() => undefined);
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export interface BackendSelectionAttempt {
	kind: BackendChannel["kind"];
	ok: boolean;
	reason?: string;
}

export interface BackendSelection {
	backend: TranscriptionBackend;
	attempts: BackendSelectionAttempt[];
}

export interface CreateBackendOptions {
	initialize: InitializeOptions;
	/** Open the Bun-FFI worker channel. Throwing means the primary runtime is unavailable. */
	openWorker?: () => Promise<BackendChannel>;
	/** Open the helper-executable channel. */
	openHelper?: () => Promise<BackendChannel>;
}

/**
 * Bring up a backend: the worker first, the helper if anything about the worker
 * did not work out.
 *
 * "Anything" is deliberate and covers FFI loading, ABI verification, worker
 * startup, and the health check that `initialize` doubles as. Each failed
 * attempt is recorded with its reason, so a session running on the fallback can
 * say *why* rather than silently being slower or different.
 */
export async function createTranscriptionBackend(options: CreateBackendOptions): Promise<BackendSelection> {
	const attempts: BackendSelectionAttempt[] = [];
	const candidates: { kind: BackendChannel["kind"]; open?: () => Promise<BackendChannel> }[] = [
		{ kind: "worker", open: options.openWorker },
		{ kind: "helper", open: options.openHelper },
	];

	for (const candidate of candidates) {
		if (!candidate.open) {
			attempts.push({ kind: candidate.kind, ok: false, reason: "not available in this build" });
			continue;
		}
		let backend: ProtocolBackend | undefined;
		try {
			backend = new ProtocolBackend(await candidate.open());
			await backend.initialize(options.initialize);
			attempts.push({ kind: candidate.kind, ok: true });
			return { backend, attempts };
		} catch (error) {
			attempts.push({
				kind: candidate.kind,
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			});
			await backend?.dispose().catch(() => undefined);
		}
	}

	const detail = attempts.map((attempt) => `${attempt.kind}: ${attempt.reason}`).join("; ");
	throw new TranscribeBackendError("internal", `No transcription backend could start. ${detail}`);
}
