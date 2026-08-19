/**
 * The versioned protocol between Orphus and a transcription backend.
 *
 * One wire format serves both backends. The primary runtime loads the native
 * library with Bun FFI inside a dedicated Worker; the fallback runs a helper
 * executable as a child process. Both speak this, so the fallback is a swap of
 * transport rather than a second implementation of the feature — which is the
 * only way "we fell back" can be a footnote instead of a different product.
 *
 * Framing is JSON Lines: one JSON object per line, newline-terminated, UTF-8.
 * A line that does not parse is a protocol error, not a message to guess at.
 */

/** Bumped when the message shapes change incompatibly. */
export const TRANSCRIBE_PROTOCOL_VERSION = 1;

/**
 * The complete set of requests. Deliberately closed: a backend that owns the
 * model, the microphone, and a native ring buffer is much easier to reason
 * about when the things it can be asked to do fit on one line.
 */
export const REQUEST_KINDS = [
	"initialize",
	"listDevices",
	"startRecording",
	"stopAndTranscribe",
	"cancel",
	"dispose",
] as const;

export type RequestKind = (typeof REQUEST_KINDS)[number];

export function isRequestKind(value: unknown): value is RequestKind {
	return typeof value === "string" && (REQUEST_KINDS as readonly string[]).includes(value);
}

export interface InitializeRequest {
	kind: "initialize";
	id: string;
	modelPath: string;
	language: string;
	/** Sample rate the capture side will deliver. */
	sampleRate: number;
}

export interface ListDevicesRequest {
	kind: "listDevices";
	id: string;
}

export interface StartRecordingRequest {
	kind: "startRecording";
	id: string;
	/** Capture device name, or omitted for the system default. */
	device?: string;
}

export interface StopAndTranscribeRequest {
	kind: "stopAndTranscribe";
	id: string;
}

export interface CancelRequest {
	kind: "cancel";
	id: string;
}

export interface DisposeRequest {
	kind: "dispose";
	id: string;
}

export type TranscribeRequest =
	| InitializeRequest
	| ListDevicesRequest
	| StartRecordingRequest
	| StopAndTranscribeRequest
	| CancelRequest
	| DisposeRequest;

/** Identifies the native library a backend actually loaded. */
export interface NativeIdentity {
	/** ABI version the library exposes. Must equal {@link EXPECTED_NATIVE_ABI_VERSION}. */
	abiVersion: number;
	/** Hash of the built artifact, so a mismatched or substituted library is visible. */
	buildHash: string;
	/** Human-readable, for diagnostics only. */
	description?: string;
}

/** The ABI this build of Orphus is written against. */
export const EXPECTED_NATIVE_ABI_VERSION = 1;

export interface CaptureDevice {
	name: string;
	/** Index among devices with the same name, so duplicates stay addressable. */
	occurrence: number;
	isDefault: boolean;
}

export interface ReadyResponse {
	kind: "ready";
	id: string;
	protocolVersion: number;
	native: NativeIdentity;
}

export interface DevicesResponse {
	kind: "devices";
	id: string;
	devices: CaptureDevice[];
}

export interface RecordingResponse {
	kind: "recording";
	id: string;
	device: string;
}

export interface LevelEvent {
	kind: "level";
	/** 0..1 input level, for the recording meter. Unsolicited, so it carries no id. */
	level: number;
}

export interface TranscriptResponse {
	kind: "transcript";
	id: string;
	text: string;
	/** Detected or configured language of the transcript. */
	language?: string;
	durationMs?: number;
}

export interface CancelledResponse {
	kind: "cancelled";
	id: string;
}

export interface DisposedResponse {
	kind: "disposed";
	id: string;
}

export type ErrorCode =
	| "abi_mismatch"
	| "protocol_error"
	| "model_load_failed"
	| "no_capture_device"
	| "capture_failed"
	| "transcription_failed"
	| "not_initialized"
	| "cancelled"
	| "internal";

export interface ErrorResponse {
	kind: "error";
	/** Absent for a failure that belongs to no particular request. */
	id?: string;
	code: ErrorCode;
	message: string;
}

export type TranscribeResponse =
	| ReadyResponse
	| DevicesResponse
	| RecordingResponse
	| LevelEvent
	| TranscriptResponse
	| CancelledResponse
	| DisposedResponse
	| ErrorResponse;

export function encodeMessage(message: TranscribeRequest | TranscribeResponse): string {
	return `${JSON.stringify(message)}\n`;
}

/**
 * Split a byte stream into whole JSON-Lines messages.
 *
 * A chunk boundary can fall anywhere, so the tail is held until its newline
 * arrives. An unparsable line is surfaced as a protocol error rather than
 * silently dropped: a backend talking gibberish is a backend to stop trusting,
 * not one to keep reading past.
 */
export class JsonLinesDecoder {
	private buffer = "";

	push(chunk: string): { messages: unknown[]; errors: string[] } {
		this.buffer += chunk;
		const messages: unknown[] = [];
		const errors: string[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (line.length === 0) continue;
			try {
				messages.push(JSON.parse(line));
			} catch {
				errors.push(line.slice(0, 200));
			}
		}
		return { messages, errors };
	}

	/** Bytes held back waiting for a newline. Non-zero at EOF means a truncated message. */
	get pending(): number {
		return this.buffer.length;
	}
}

export interface AbiCheck {
	ok: boolean;
	reason?: string;
}

/**
 * Accept or reject a backend by what it says it loaded.
 *
 * Both halves matter. The ABI version says the function signatures match; the
 * build hash says it is the artifact this release shipped and not one that
 * happens to export the same names. A backend that fails either is refused
 * before it is asked to do anything.
 */
export function verifyNativeIdentity(
	native: NativeIdentity | undefined,
	expected: { abiVersion?: number; buildHash?: string },
): AbiCheck {
	if (!native) return { ok: false, reason: "the backend did not report a native identity" };
	const expectedAbi = expected.abiVersion ?? EXPECTED_NATIVE_ABI_VERSION;
	if (native.abiVersion !== expectedAbi) {
		return { ok: false, reason: `native ABI ${native.abiVersion} does not match the expected ${expectedAbi}` };
	}
	if (expected.buildHash !== undefined && native.buildHash !== expected.buildHash) {
		return {
			ok: false,
			reason: `native build ${native.buildHash.slice(0, 12)} does not match the expected ${expected.buildHash.slice(0, 12)}`,
		};
	}
	return { ok: true };
}

/**
 * Validate an inbound response: the kind, and every field this client reads.
 * A known kind with malformed fields is as much a protocol violation as an
 * unknown one — `undefined` here is the caller's cue to stop trusting the
 * backend, not to guess at what it meant.
 */
export function parseResponse(value: unknown): TranscribeResponse | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	const id = typeof candidate.id === "string";
	switch (candidate.kind) {
		case "ready": {
			const native = candidate.native as Partial<NativeIdentity> | undefined;
			return id &&
				typeof candidate.protocolVersion === "number" &&
				typeof native === "object" &&
				native !== null &&
				typeof native.abiVersion === "number" &&
				typeof native.buildHash === "string"
				? (value as ReadyResponse)
				: undefined;
		}
		case "devices":
			return id &&
				Array.isArray(candidate.devices) &&
				candidate.devices.every(
					(device: unknown) =>
						typeof device === "object" &&
						device !== null &&
						typeof (device as CaptureDevice).name === "string" &&
						typeof (device as CaptureDevice).occurrence === "number" &&
						typeof (device as CaptureDevice).isDefault === "boolean",
				)
				? (value as DevicesResponse)
				: undefined;
		case "recording":
			return id && typeof candidate.device === "string" ? (value as RecordingResponse) : undefined;
		case "level":
			return typeof candidate.level === "number" ? (value as LevelEvent) : undefined;
		case "transcript":
			return id && typeof candidate.text === "string" ? (value as TranscriptResponse) : undefined;
		case "cancelled":
		case "disposed":
			return id ? (value as TranscribeResponse) : undefined;
		case "error":
			return typeof candidate.code === "string" && typeof candidate.message === "string"
				? (value as ErrorResponse)
				: undefined;
		default:
			return undefined;
	}
}
