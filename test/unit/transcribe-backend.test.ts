import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
	type BackendChannel,
	createTranscriptionBackend,
	DISPOSE_ACK_TIMEOUT_MS,
	INITIALIZE_TIMEOUT_MS,
	ProtocolBackend,
	TranscribeBackendError,
} from "../../packages/transcribe/src/backend.js";
import { nativeTriple, openHelperChannel } from "../../packages/transcribe/src/channels.js";
import { createFakeChannel } from "../../packages/transcribe/src/fake-channel.js";
import {
	EXPECTED_NATIVE_ABI_VERSION,
	JsonLinesDecoder,
	REQUEST_KINDS,
	TRANSCRIBE_PROTOCOL_VERSION,
	verifyNativeIdentity,
} from "../../packages/transcribe/src/protocol.js";

const INIT = { modelPath: "/models/tiny.gguf", language: "en", sampleRate: 16_000 };

async function ready(options?: Parameters<typeof createFakeChannel>[0]) {
	const channel = createFakeChannel(options);
	const backend = new ProtocolBackend(channel);
	await backend.initialize(INIT);
	return { channel, backend };
}

test("the request vocabulary is exactly the six the protocol names", () => {
	assert.deepEqual(
		[...REQUEST_KINDS],
		["initialize", "listDevices", "startRecording", "stopAndTranscribe", "cancel", "dispose"],
	);
});

test("a full dictation round trip speaks only those requests", async () => {
	const { channel, backend } = await ready();

	const devices = await backend.listDevices();
	await backend.startRecording(devices[0]?.name);
	const transcript = await backend.stopAndTranscribe();
	await backend.dispose();

	assert.equal(transcript.text, "hello from the fake backend");
	assert.deepEqual(
		channel.requests.map((request) => request.kind),
		["initialize", "listDevices", "startRecording", "stopAndTranscribe", "dispose"],
	);
	assert.equal(channel.closed, true);
});

test("the native ABI version and build hash are both verified before the backend is used", async () => {
	assert.equal(verifyNativeIdentity(undefined, {}).ok, false);
	assert.equal(verifyNativeIdentity({ abiVersion: 99, buildHash: "a" }, {}).ok, false);
	assert.equal(verifyNativeIdentity({ abiVersion: EXPECTED_NATIVE_ABI_VERSION, buildHash: "a" }, {}).ok, true);
	const mismatch = verifyNativeIdentity(
		{ abiVersion: EXPECTED_NATIVE_ABI_VERSION, buildHash: "a".repeat(64) },
		{
			buildHash: "b".repeat(64),
		},
	);
	assert.equal(mismatch.ok, false);
	assert.match(mismatch.reason ?? "", /does not match the expected/);
});

test("a backend reporting the wrong ABI is refused rather than used", async () => {
	const backend = new ProtocolBackend(createFakeChannel({ native: { abiVersion: 2 } }));
	await assert.rejects(backend.initialize(INIT), (error: unknown) => {
		assert.ok(error instanceof TranscribeBackendError);
		assert.equal(error.code, "abi_mismatch");
		assert.match(error.message, /native ABI 2 does not match the expected 1/);
		return true;
	});
});

test("a backend reporting a different build hash is refused", async () => {
	const backend = new ProtocolBackend(createFakeChannel({ native: { buildHash: "c".repeat(64) } }));
	await assert.rejects(
		backend.initialize({ ...INIT, expectedBuildHash: "d".repeat(64) }),
		/native build cccccccccccc does not match/,
	);
});

test("a backend speaking a different protocol version is refused", async () => {
	const backend = new ProtocolBackend(createFakeChannel({ protocolVersion: TRANSCRIBE_PROTOCOL_VERSION + 1 }));
	await assert.rejects(backend.initialize(INIT), /Backend speaks protocol 2; this build speaks 1/);
});

test("a crashed backend fails everything in flight instead of hanging", async () => {
	const channel = createFakeChannel({ silentFor: ["stopAndTranscribe"] });
	const backend = new ProtocolBackend(channel);
	await backend.initialize(INIT);
	await backend.startRecording();

	const pending = backend.stopAndTranscribe();
	channel.crash("worker exited");

	await assert.rejects(pending, /Backend stopped: worker exited/);
	await assert.rejects(backend.listDevices(), /Backend unavailable: worker exited/);
});

test("an unparsable line is terminal: in-flight requests fail and the backend closes", async () => {
	const channel = createFakeChannel({ silentFor: ["listDevices"] });
	const backend = new ProtocolBackend(channel);
	await backend.initialize(INIT);

	const pending = backend.listDevices();
	channel.emitRaw("{ this is not json\n");

	await assert.rejects(pending, /protocol violation: unparsable line/);
	// A backend talking gibberish is one to stop trusting, not to keep using.
	await assert.rejects(backend.listDevices(), /Backend unavailable/);
	assert.equal(channel.closed, true);
});

test("a known response kind with malformed fields is a protocol violation, not data", async () => {
	const channel = createFakeChannel({ silentFor: ["stopAndTranscribe"] });
	const backend = new ProtocolBackend(channel);
	await backend.initialize(INIT);
	await backend.startRecording();

	const pending = backend.stopAndTranscribe();
	channel.emitRaw(`${JSON.stringify({ kind: "transcript", id: "3", text: 42 })}\n`);

	await assert.rejects(pending, /protocol violation: invalid message/);
	assert.equal(channel.closed, true);
});

test("a backend that opens but never answers `initialize` cannot stall the fallback ladder", async () => {
	// A wedged native library gets exactly this far: the channel opens, then
	// nothing is ever written and nothing closes. The bounded handshake is what
	// lets the helper attempt start.
	vi.useFakeTimers();
	try {
		const pending = createTranscriptionBackend({
			initialize: INIT,
			openWorker: async () => createFakeChannel({ kind: "worker", silentFor: ["initialize", "dispose"] }),
			openHelper: async () => createFakeChannel({ kind: "helper" }),
		});
		await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS + DISPOSE_ACK_TIMEOUT_MS);
		const selection = await pending;
		assert.equal(selection.backend.kind, "helper");
		assert.match(selection.attempts[0].reason ?? "", /initialize timed out/);
	} finally {
		vi.useRealTimers();
	}
});

test("a backend that ignores `dispose` cannot stall the fallback ladder", async () => {
	// The worker answers `ready` with the wrong ABI and then never answers the
	// cleanup `dispose`; the bounded acknowledgement wait is what lets the
	// helper attempt start at all.
	vi.useFakeTimers();
	try {
		const pending = createTranscriptionBackend({
			initialize: INIT,
			openWorker: async () =>
				createFakeChannel({ kind: "worker", native: { abiVersion: 9 }, silentFor: ["dispose"] }),
			openHelper: async () => createFakeChannel({ kind: "helper" }),
		});
		await vi.advanceTimersByTimeAsync(DISPOSE_ACK_TIMEOUT_MS);
		const selection = await pending;
		assert.equal(selection.backend.kind, "helper");
		assert.match(selection.attempts[0].reason ?? "", /native ABI 9/);
	} finally {
		vi.useRealTimers();
	}
});

test("no capture device surfaces as its own error rather than a generic failure", async () => {
	const { backend } = await ready({
		failures: { startRecording: { code: "no_capture_device", message: "no microphone was found" } },
	});
	await assert.rejects(backend.startRecording(), (error: unknown) => {
		assert.ok(error instanceof TranscribeBackendError);
		assert.equal(error.code, "no_capture_device");
		return true;
	});
});

test("cancelling mid-transcription reports cancellation, not a transcript", async () => {
	const { backend } = await ready();
	await backend.startRecording();
	await backend.cancel();
	// After a cancel there is nothing recording, so a stop is an error rather
	// than a silently empty transcript.
	await assert.rejects(backend.stopAndTranscribe(), /not recording/);
});

test("level events reach the meter and stop when unsubscribed", async () => {
	const { channel, backend } = await ready();
	const levels: number[] = [];
	const unsubscribe = backend.onLevel((level) => levels.push(level));
	channel.emitLevel(0.25);
	channel.emitLevel(0.5);
	unsubscribe();
	channel.emitLevel(0.75);
	assert.deepEqual(levels, [0.25, 0.5]);
});

test("the helper takes over when the worker cannot start, and the reason is recorded", async () => {
	const helper = createFakeChannel({ kind: "helper" });
	const selection = await createTranscriptionBackend({
		initialize: INIT,
		openWorker: async () => {
			throw new Error("no native transcription library at /native/linux-x64-gnu/orphus_transcribe.so");
		},
		openHelper: async () => helper,
	});

	assert.equal(selection.backend.kind, "helper");
	assert.deepEqual(
		selection.attempts.map((attempt) => [attempt.kind, attempt.ok]),
		[
			["worker", false],
			["helper", true],
		],
	);
	assert.match(selection.attempts[0].reason ?? "", /no native transcription library/);
	// The fallback is a live backend, not a stub that reports success and does nothing.
	await selection.backend.startRecording();
	assert.equal((await selection.backend.stopAndTranscribe()).text, "hello from the fake backend");
});

test("the helper also takes over when the worker starts but fails ABI verification", async () => {
	const selection = await createTranscriptionBackend({
		initialize: INIT,
		openWorker: async () => createFakeChannel({ kind: "worker", native: { abiVersion: 7 } }),
		openHelper: async () => createFakeChannel({ kind: "helper" }),
	});
	assert.equal(selection.backend.kind, "helper");
	assert.match(selection.attempts[0].reason ?? "", /native ABI 7/);
});

test("the helper also takes over when the worker fails its health check", async () => {
	const selection = await createTranscriptionBackend({
		initialize: INIT,
		openWorker: async () =>
			createFakeChannel({
				kind: "worker",
				failures: { initialize: { code: "model_load_failed", message: "bad gguf" } },
			}),
		openHelper: async () => createFakeChannel({ kind: "helper" }),
	});
	assert.equal(selection.backend.kind, "helper");
	assert.match(selection.attempts[0].reason ?? "", /bad gguf/);
});

test("with neither backend available, the failure names both reasons", async () => {
	await assert.rejects(
		createTranscriptionBackend({
			initialize: INIT,
			openWorker: async () => {
				throw new Error("no library");
			},
			openHelper: async () => {
				throw new Error("no helper");
			},
		}),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /worker: no library/);
			assert.match(message, /helper: no helper/);
			return true;
		},
	);
});

test("a build with no backends at all says so rather than throwing something opaque", async () => {
	await assert.rejects(createTranscriptionBackend({ initialize: INIT }), /not available in this build/);
});

test("the JSON-Lines decoder reassembles messages split across chunks", () => {
	const decoder = new JsonLinesDecoder();
	assert.deepEqual(decoder.push('{"kind":"lev').messages, []);
	assert.ok(decoder.pending > 0);
	const finished = decoder.push('el","level":0.5}\n{"kind":"disposed","id":"1"}\n');
	assert.deepEqual(finished.messages, [
		{ kind: "level", level: 0.5 },
		{ kind: "disposed", id: "1" },
	]);
	assert.equal(decoder.pending, 0);
	assert.deepEqual(finished.errors, []);
});

test("native artifacts are addressed per platform, with glibc and musl kept apart", () => {
	assert.equal(nativeTriple("darwin", "arm64"), "macos-arm64");
	assert.equal(nativeTriple("darwin", "x64"), "macos-x64");
	assert.equal(nativeTriple("win32", "arm64"), "windows-arm64");
	assert.match(nativeTriple("linux", "x64"), /^linux-x64-(gnu|musl)$/);
	assert.match(nativeTriple("linux", "arm64"), /^linux-arm64-(gnu|musl)$/);
});

test.runIf(process.platform !== "win32")(
	"a write racing the helper's exit closes the channel instead of crashing the host",
	async () => {
		// A real helper that exits immediately, so its stdin pipe is dead by the
		// time the write lands. Without an "error" listener on stdin, that EPIPE
		// is an uncaught exception — this test failing the process is exactly the
		// regression it exists to catch.
		const nativeDir = join(tmpdir(), `orphus-transcribe-epipe-${process.pid}-${Date.now()}`);
		const tripleDir = join(nativeDir, nativeTriple());
		await mkdir(tripleDir, { recursive: true });
		const helperPath = join(tripleDir, "orphus-transcribe-helper");
		await writeFile(helperPath, "#!/bin/sh\nexit 0\n");
		await chmod(helperPath, 0o755);

		const channel = await openHelperChannel({ nativeDir });
		const closeReasons: string[] = [];
		channel.onClose((reason) => closeReasons.push(reason));
		// Wait for the helper to be gone, then write into the dead pipe.
		await new Promise((resolve) => setTimeout(resolve, 200));
		channel.send('{"kind":"listDevices","id":"1"}\n');
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.ok(closeReasons.length > 0, "the exit or the failed write must close the channel");
		await channel.close();
	},
);

test("a channel that never answers leaves the request pending until the channel dies", async () => {
	const listeners: ((reason: string) => void)[] = [];
	const silent: BackendChannel = {
		kind: "helper",
		send: () => {},
		onLine: () => {},
		onClose: (listener) => listeners.push(listener),
		close: () => {},
	};
	const backend = new ProtocolBackend(silent);
	const pending = backend.initialize(INIT);
	for (const listener of listeners) listener("helper exited with code 1");
	await assert.rejects(pending, /helper exited with code 1/);
});
