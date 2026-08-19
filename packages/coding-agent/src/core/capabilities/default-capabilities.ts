import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type {
	BrowserCapability,
	ClockCapability,
	CredentialCapability,
	FileStat,
	FileSystemCapability,
	HarnessCapabilities,
	HarnessCapabilityOverrides,
	ProcessCapability,
	ProcessExit,
	ProcessHandle,
	ProcessResult,
	SpawnOptions,
	TerminalTransportCapability,
	TranscriptionCapability,
	WriteFileOptions,
} from "./types.ts";

export const systemClock: ClockCapability = {
	kind: "system",
	now: () => Date.now(),
	monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
	sleep: (ms, signal) => delay(ms, undefined, { signal }),
};

function isMissingPath(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
	);
}

export const nodeFileSystem: FileSystemCapability = {
	kind: "node-fs",
	readFile: (path) => readFile(path, "utf8"),
	writeFile: (path, data, options?: WriteFileOptions) =>
		writeFile(path, data, { encoding: "utf8", mode: options?.mode, flag: options?.flag }),
	mkdir: async (path, options) => {
		await mkdir(path, { recursive: options?.recursive ?? false, mode: options?.mode });
	},
	stat: async (path): Promise<FileStat | undefined> => {
		try {
			const stats = await stat(path);
			return { size: stats.size, mode: stats.mode & 0o777, isDirectory: stats.isDirectory() };
		} catch (error) {
			if (isMissingPath(error)) return undefined;
			throw error;
		}
	},
	remove: (path) => rm(path, { force: true, recursive: true }),
};

export const nodeProcesses: ProcessCapability = {
	kind: "node-child-process",
	spawn(command: string, args: readonly string[], options?: SpawnOptions): ProcessHandle {
		const child = nodeSpawn(command, [...args], {
			cwd: options?.cwd,
			env: options?.env ? { ...process.env, ...options.env } : process.env,
			signal: options?.signal,
			// Nothing reads these: `ProcessHandle` offers no stream access, and an
			// undrained pipe eventually blocks a long-lived child. `exec` is the
			// capability for output.
			stdio: "ignore",
		});
		// `spawn` reports a missing binary asynchronously through "error"; fold that
		// into the same settled exit every caller already awaits so a failed launch
		// never leaves `exited` pending.
		const exited = new Promise<ProcessExit>((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
			child.once("error", () => resolve({ code: null, signal: null }));
		});
		return {
			get pid() {
				return child.pid;
			},
			exited,
			kill: (signal) => {
				child.kill(signal);
			},
		};
	},
	exec(command: string, args: readonly string[], options?: SpawnOptions): Promise<ProcessResult> {
		return new Promise<ProcessResult>((resolve) => {
			const child = nodeSpawn(command, [...args], {
				cwd: options?.cwd,
				env: options?.env ? { ...process.env, ...options.env } : process.env,
				signal: options?.signal,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			// setEncoding decodes statefully, so a multi-byte character split
			// across two chunks arrives whole instead of as replacement characters.
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			// "close", not "exit": exit can fire while stdio is still draining (a
			// grandchild can hold the pipes open), and resolving there loses
			// trailing output. "close" waits for both streams to end.
			child.once("close", (code) => resolve({ code, stdout, stderr }));
			child.once("error", (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
		});
	},
};

/**
 * The default credential capability holds nothing. A build without an OS
 * keychain binding must fail closed — an empty vault denies credential
 * injection rather than silently falling back to some other source.
 */
export const emptyCredentials: CredentialCapability = {
	kind: "empty",
	list: async () => [],
	reveal: async () => undefined,
};

export const unavailableBrowser: BrowserCapability = {
	kind: "unavailable",
	isAvailable: () => false,
};

export const unavailableTranscription: TranscriptionCapability = {
	kind: "unavailable",
	isAvailable: () => false,
};

/** stdin/stdout as the terminal. Used by every renderer outside tests. */
export function createStdioTerminalTransport(): TerminalTransportCapability {
	return {
		kind: "stdio",
		get isTTY() {
			return process.stdout.isTTY === true;
		},
		columns: () => process.stdout.columns ?? 80,
		rows: () => process.stdout.rows ?? 24,
		write: (data) => {
			process.stdout.write(data);
		},
		setRawMode: (enabled) => {
			if (process.stdin.isTTY) process.stdin.setRawMode(enabled);
		},
		onData: (listener) => {
			// Stateful decoding without touching process-global stdin encoding:
			// a paste can split a multi-byte character across reads.
			const decoder = new StringDecoder("utf8");
			const handler = (chunk: Buffer | string) => {
				listener(typeof chunk === "string" ? chunk : decoder.write(chunk));
			};
			process.stdin.on("data", handler);
			return () => {
				process.stdin.off("data", handler);
			};
		},
		onResize: (listener) => {
			process.stdout.on("resize", listener);
			return () => {
				process.stdout.off("resize", listener);
			};
		},
	};
}

/** The production bundle, with any subset replaced. */
export function createDefaultCapabilities(overrides?: HarnessCapabilityOverrides): HarnessCapabilities {
	return {
		clock: systemClock,
		fs: nodeFileSystem,
		process: nodeProcesses,
		credentials: emptyCredentials,
		browser: unavailableBrowser,
		transcription: unavailableTranscription,
		terminal: createStdioTerminalTransport(),
		...overrides,
	};
}
