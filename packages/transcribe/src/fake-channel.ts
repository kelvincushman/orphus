import type { BackendChannel } from "./backend.ts";
import {
	type CaptureDevice,
	EXPECTED_NATIVE_ABI_VERSION,
	encodeMessage,
	isRequestKind,
	type NativeIdentity,
	TRANSCRIBE_PROTOCOL_VERSION,
	type TranscribeRequest,
} from "./protocol.ts";

/**
 * A backend that answers from a script.
 *
 * It is a *channel*, not a stand-in backend: everything above it — request
 * correlation, ABI verification, the fallback ladder, cancellation, crash
 * handling — is the code that ships. A test that passes here has exercised the
 * real client against a scripted peer, which is the only kind of fake worth
 * having for a protocol.
 */
export interface FakeChannelOptions {
	kind?: BackendChannel["kind"];
	native?: Partial<NativeIdentity>;
	protocolVersion?: number;
	devices?: CaptureDevice[];
	transcript?: { text: string; language?: string; durationMs?: number };
	/** Fail a given request kind with this error instead of answering it. */
	failures?: Partial<Record<TranscribeRequest["kind"], { code: string; message: string }>>;
	/** Do not answer these request kinds at all, to test a hung backend. */
	silentFor?: TranscribeRequest["kind"][];
}

export interface FakeChannel extends BackendChannel {
	/** Every request the client sent, decoded. */
	readonly requests: TranscribeRequest[];
	/** Emit an unsolicited level event. */
	emitLevel(level: number): void;
	/** Emit a raw line, including malformed ones. */
	emitRaw(line: string): void;
	/** Simulate the backend dying. */
	crash(reason: string): void;
	readonly closed: boolean;
}

export function createFakeChannel(options: FakeChannelOptions = {}): FakeChannel {
	const requests: TranscribeRequest[] = [];
	const lineListeners = new Set<(line: string) => void>();
	const closeListeners = new Set<(reason: string) => void>();
	let closed = false;
	let recording = false;

	const emit = (line: string) => {
		for (const listener of [...lineListeners]) listener(line);
	};
	const native: NativeIdentity = {
		abiVersion: options.native?.abiVersion ?? EXPECTED_NATIVE_ABI_VERSION,
		buildHash: options.native?.buildHash ?? "b".repeat(64),
		...(options.native?.description ? { description: options.native.description } : {}),
	};

	const answer = (request: TranscribeRequest): void => {
		if (options.silentFor?.includes(request.kind)) return;
		const failure = options.failures?.[request.kind];
		if (failure) {
			emit(encodeMessage({ kind: "error", id: request.id, code: failure.code as never, message: failure.message }));
			return;
		}
		switch (request.kind) {
			case "initialize":
				emit(
					encodeMessage({
						kind: "ready",
						id: request.id,
						protocolVersion: options.protocolVersion ?? TRANSCRIBE_PROTOCOL_VERSION,
						native,
					}),
				);
				return;
			case "listDevices":
				emit(
					encodeMessage({
						kind: "devices",
						id: request.id,
						devices: options.devices ?? [{ name: "Built-in Microphone", occurrence: 0, isDefault: true }],
					}),
				);
				return;
			case "startRecording":
				recording = true;
				emit(encodeMessage({ kind: "recording", id: request.id, device: request.device ?? "system default" }));
				return;
			case "stopAndTranscribe": {
				if (!recording) {
					emit(
						encodeMessage({ kind: "error", id: request.id, code: "not_initialized", message: "not recording" }),
					);
					return;
				}
				recording = false;
				const transcript = options.transcript ?? { text: "hello from the fake backend" };
				emit(encodeMessage({ kind: "transcript", id: request.id, ...transcript }));
				return;
			}
			case "cancel":
				recording = false;
				emit(encodeMessage({ kind: "cancelled", id: request.id }));
				return;
			case "dispose":
				emit(encodeMessage({ kind: "disposed", id: request.id }));
				return;
		}
	};

	return {
		kind: options.kind ?? "fake",
		requests,
		get closed() {
			return closed;
		},
		send(line) {
			for (const raw of line.split("\n")) {
				const trimmed = raw.trim();
				if (!trimmed) continue;
				const parsed = JSON.parse(trimmed) as TranscribeRequest;
				if (!isRequestKind(parsed.kind)) {
					emit(
						encodeMessage({ kind: "error", code: "protocol_error", message: `unknown request ${parsed.kind}` }),
					);
					continue;
				}
				requests.push(parsed);
				answer(parsed);
			}
		},
		onLine: (listener) => lineListeners.add(listener),
		onClose: (listener) => closeListeners.add(listener),
		close() {
			closed = true;
		},
		emitLevel: (level) => emit(encodeMessage({ kind: "level", level })),
		emitRaw: (line) => emit(line),
		crash(reason) {
			closed = true;
			for (const listener of [...closeListeners]) listener(reason);
		},
	};
}
