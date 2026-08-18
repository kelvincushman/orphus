import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BackendChannel } from "./backend.ts";
import { TranscribeBackendError } from "./backend.ts";

/**
 * Where the native artifacts live in an installed build.
 *
 * Both the shared library the worker loads through FFI and the helper
 * executable the fallback runs are per-platform files under `native/`. They are
 * produced by the native build, not by this package's TypeScript.
 */
export function nativeTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
	const cpu = arch === "arm64" ? "arm64" : "x64";
	if (os !== "linux") return `${os}-${cpu}`;
	// glibc and musl are not interchangeable, and a musl host loading a glibc
	// build fails at dlopen with a message nobody can act on.
	return `${os}-${cpu}-${isMuslHost() ? "musl" : "gnu"}`;
}

function isMuslHost(): boolean {
	const report = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } };
	return report.header?.glibcVersionRuntime === undefined;
}

export function nativeLibraryPath(nativeDir: string, triple = nativeTriple()): string {
	const extension = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
	return join(nativeDir, triple, `orphus_transcribe.${extension}`);
}

export function helperExecutablePath(nativeDir: string, triple = nativeTriple()): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	return join(nativeDir, triple, `orphus-transcribe-helper${suffix}`);
}

/** True only under Bun, whose FFI is what the primary runtime needs. */
export function isBunRuntime(): boolean {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

export interface ChannelPaths {
	/** Directory holding the per-platform native artifacts. */
	nativeDir: string;
	/** Entry the Bun Worker runs. Defaults to this package's worker entry. */
	workerEntry?: string;
	exists?: (path: string) => boolean;
}

/**
 * Open the primary channel: a dedicated Bun Worker that owns the model, the
 * transcription session, the microphone, the native ring buffer, and the
 * cancellation token.
 *
 * A Worker rather than the main thread because transcription is a long,
 * CPU-bound native call: run on the main thread it would block the very UI
 * whose Escape key is supposed to cancel it.
 */
export async function openWorkerChannel(paths: ChannelPaths): Promise<BackendChannel> {
	const exists = paths.exists ?? existsSync;
	if (!isBunRuntime()) {
		throw new TranscribeBackendError("internal", "the Bun-FFI worker runtime is only available under Bun");
	}
	const libraryPath = nativeLibraryPath(paths.nativeDir);
	if (!exists(libraryPath)) {
		throw new TranscribeBackendError("internal", `no native transcription library at ${libraryPath}`);
	}
	// worker-entry.ts is the Bun-FFI shim over the native library and ships in
	// the same change as the native artifacts (see native/ABI.md — Status). Until
	// then this check fails the worker attempt with a reason the fallback ladder
	// records, rather than pretending a runtime exists.
	const workerEntry = paths.workerEntry ?? new URL("./worker-entry.ts", import.meta.url).pathname;
	if (!exists(workerEntry)) {
		throw new TranscribeBackendError(
			"internal",
			`the worker runtime ships with the native artifacts and is not present at ${workerEntry}`,
		);
	}

	const worker = new Worker(workerEntry, { type: "module" });
	const lineListeners = new Set<(line: string) => void>();
	const closeListeners = new Set<(reason: string) => void>();
	worker.addEventListener("message", (event: MessageEvent) => {
		const data = typeof event.data === "string" ? event.data : String(event.data);
		for (const listener of [...lineListeners]) listener(data);
	});
	worker.addEventListener("error", (event: ErrorEvent) => {
		for (const listener of [...closeListeners]) listener(event.message || "worker error");
	});
	worker.addEventListener("close", () => {
		for (const listener of [...closeListeners]) listener("worker exited");
	});
	worker.postMessage(JSON.stringify({ kind: "load", libraryPath }));

	return {
		kind: "worker",
		send: (line) => worker.postMessage(line),
		onLine: (listener) => lineListeners.add(listener),
		onClose: (listener) => closeListeners.add(listener),
		close: () => worker.terminate(),
	};
}

/**
 * Open the fallback channel: the helper executable, over stdin/stdout.
 *
 * Same protocol, different transport. It exists so a runtime without Bun FFI —
 * or with a native library that will not load — still transcribes.
 */
export async function openHelperChannel(paths: ChannelPaths): Promise<BackendChannel> {
	const exists = paths.exists ?? existsSync;
	const helperPath = helperExecutablePath(paths.nativeDir);
	if (!exists(helperPath)) {
		throw new TranscribeBackendError("internal", `no transcription helper at ${helperPath}`);
	}
	const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
	const lineListeners = new Set<(line: string) => void>();
	const closeListeners = new Set<(reason: string) => void>();
	let stderr = "";

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		for (const listener of [...lineListeners]) listener(chunk);
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		// Kept bounded: the helper's diagnostics are for the exit message, not a log.
		stderr = `${stderr}${chunk}`.slice(-2048);
	});
	const notifyClose = (reason: string) => {
		for (const listener of [...closeListeners]) listener(reason);
	};
	child.once("exit", (code, signal) => {
		const detail = stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : "";
		notifyClose(signal ? `helper killed by ${signal}${detail}` : `helper exited with code ${code}${detail}`);
	});
	child.once("error", (error) => notifyClose(`helper failed to start: ${error.message}`));
	// A write can race the helper's exit and land on a closed pipe. Without a
	// listener that EPIPE is an uncaught exception in the host; with one it is
	// just another way the channel closed.
	child.stdin.on("error", (error) => notifyClose(`helper stdin failed: ${error.message}`));

	return {
		kind: "helper",
		send: (line) => child.stdin.write(line),
		onLine: (listener) => lineListeners.add(listener),
		onClose: (listener) => closeListeners.add(listener),
		close: () => {
			child.stdin.end();
			child.kill();
		},
	};
}
