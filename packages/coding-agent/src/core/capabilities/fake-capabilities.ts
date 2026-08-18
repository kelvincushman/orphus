import { dirname, resolve as resolvePath } from "node:path";
import type {
	BrowserCapability,
	ClockCapability,
	CredentialCapability,
	CredentialRecord,
	FileStat,
	FileSystemCapability,
	HarnessCapabilities,
	HarnessCapabilityOverrides,
	ProcessCapability,
	ProcessExit,
	ProcessHandle,
	ProcessResult,
	TerminalTransportCapability,
	TranscriptionCapability,
	WriteFileOptions,
} from "./types.ts";

/**
 * Deterministic capabilities. The replay harness and the unit suites boot the
 * real loader and the real session orchestration against these, so a test
 * exercises production composition rather than a parallel one.
 */

export interface FakeClock extends ClockCapability {
	/** Move both clocks forward and settle every sleep whose deadline has passed. */
	advance(ms: number): Promise<void>;
}

export function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
	let wall = startMs;
	let monotonic = 0;
	let pending: { deadline: number; resolve: () => void; reject: (reason: unknown) => void }[] = [];
	return {
		kind: "fake",
		now: () => wall,
		monotonicNow: () => monotonic,
		sleep(ms, signal) {
			if (signal?.aborted) return Promise.reject(signal.reason);
			return new Promise<void>((resolve, reject) => {
				const entry = { deadline: monotonic + ms, resolve, reject };
				pending.push(entry);
				signal?.addEventListener(
					"abort",
					() => {
						pending = pending.filter((item) => item !== entry);
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		},
		async advance(ms) {
			wall += ms;
			monotonic += ms;
			const due = pending.filter((entry) => entry.deadline <= monotonic);
			pending = pending.filter((entry) => entry.deadline > monotonic);
			for (const entry of due) entry.resolve();
			// Yield so the resolved continuations run before the caller asserts.
			await Promise.resolve();
		},
	};
}

export interface FakeFileSystem extends FileSystemCapability {
	/** Every file written, keyed by resolved absolute path. */
	readonly files: Map<string, { data: string; mode: number }>;
	/** Force the next `writeFile` for a path to fail, for fail-closed tests. */
	failWrites(matcher: (path: string) => boolean, error?: Error): void;
}

export function createFakeFileSystem(seed?: Record<string, string>): FakeFileSystem {
	const files = new Map<string, { data: string; mode: number }>();
	const directories = new Set<string>();
	let writeFailure: { matcher: (path: string) => boolean; error: Error } | undefined;
	for (const [path, data] of Object.entries(seed ?? {})) {
		files.set(resolvePath(path), { data, mode: 0o600 });
		directories.add(dirname(resolvePath(path)));
	}
	return {
		kind: "fake",
		files,
		failWrites(matcher, error = new Error("EACCES: fake filesystem write denied")) {
			writeFailure = { matcher, error };
		},
		async readFile(path) {
			const entry = files.get(resolvePath(path));
			if (!entry) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
			return entry.data;
		},
		async writeFile(path, data, options?: WriteFileOptions) {
			const absolute = resolvePath(path);
			if (writeFailure?.matcher(absolute)) throw writeFailure.error;
			if (options?.flag === "wx" && files.has(absolute)) {
				throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
			}
			files.set(absolute, { data, mode: options?.mode ?? 0o600 });
		},
		async mkdir(path) {
			directories.add(resolvePath(path));
		},
		async stat(path): Promise<FileStat | undefined> {
			const absolute = resolvePath(path);
			const file = files.get(absolute);
			if (file) return { size: Buffer.byteLength(file.data, "utf8"), mode: file.mode, isDirectory: false };
			if (directories.has(absolute)) return { size: 0, mode: 0o700, isDirectory: true };
			return undefined;
		},
		async remove(path) {
			const absolute = resolvePath(path);
			files.delete(absolute);
			directories.delete(absolute);
		},
	};
}

export interface ScriptedProcess {
	/** Exit status the spawned process settles with. */
	exit?: ProcessExit;
	/** What `exec` returns for this command. */
	result?: ProcessResult;
}

export interface FakeProcesses extends ProcessCapability {
	readonly spawned: { command: string; args: string[]; cwd?: string }[];
	/** Processes still running — the assertion a teardown test needs. */
	readonly alive: number;
	script(command: string, scripted: ScriptedProcess): void;
}

export function createFakeProcesses(): FakeProcesses {
	const spawned: { command: string; args: string[]; cwd?: string }[] = [];
	const scripts = new Map<string, ScriptedProcess>();
	let alive = 0;
	return {
		kind: "fake",
		spawned,
		get alive() {
			return alive;
		},
		script(command, scripted) {
			scripts.set(command, scripted);
		},
		async exec(command, args, options): Promise<ProcessResult> {
			spawned.push({ command, args: [...args], cwd: options?.cwd });
			return scripts.get(command)?.result ?? { code: 0, stdout: "", stderr: "" };
		},
		spawn(command, args, options): ProcessHandle {
			spawned.push({ command, args: [...args], cwd: options?.cwd });
			alive += 1;
			let settle: (exit: ProcessExit) => void = () => {};
			const exited = new Promise<ProcessExit>((resolve) => {
				settle = (exit) => {
					alive -= 1;
					resolve(exit);
				};
			});
			const scripted = scripts.get(command);
			if (scripted?.exit) settle(scripted.exit);
			return {
				pid: 1000 + spawned.length,
				exited,
				kill: () => settle({ code: null, signal: "SIGTERM" }),
			};
		},
	};
}

export function createFakeCredentials(entries: (CredentialRecord & { secret: string })[] = []): CredentialCapability {
	return {
		kind: "fake",
		list: async () => entries.map(({ label, origin, username }) => ({ label, origin, username })),
		reveal: async (label) => entries.find((entry) => entry.label === label)?.secret,
	};
}

export const fakeBrowser: BrowserCapability = { kind: "fake", isAvailable: () => true };
export const fakeTranscription: TranscriptionCapability = { kind: "fake", isAvailable: () => true };

export interface FakeTerminalTransport extends TerminalTransportCapability {
	/** Everything the renderer wrote, in order. */
	readonly writes: string[];
	/** All writes concatenated — the input to an ANSI assertion. */
	output(): string;
	/** Feed input as if typed. */
	send(chunk: string): void;
	resize(columns: number, rows: number): void;
	readonly rawModeChanges: boolean[];
}

export function createFakeTerminalTransport(options?: {
	columns?: number;
	rows?: number;
	isTTY?: boolean;
}): FakeTerminalTransport {
	const writes: string[] = [];
	const rawModeChanges: boolean[] = [];
	const dataListeners = new Set<(chunk: string) => void>();
	const resizeListeners = new Set<() => void>();
	let columns = options?.columns ?? 80;
	let rows = options?.rows ?? 24;
	return {
		kind: "fake",
		isTTY: options?.isTTY ?? true,
		writes,
		rawModeChanges,
		output: () => writes.join(""),
		columns: () => columns,
		rows: () => rows,
		write: (data) => {
			writes.push(data);
		},
		setRawMode: (enabled) => {
			rawModeChanges.push(enabled);
		},
		onData: (listener) => {
			dataListeners.add(listener);
			return () => dataListeners.delete(listener);
		},
		onResize: (listener) => {
			resizeListeners.add(listener);
			return () => resizeListeners.delete(listener);
		},
		send: (chunk) => {
			for (const listener of [...dataListeners]) listener(chunk);
		},
		resize: (nextColumns, nextRows) => {
			columns = nextColumns;
			rows = nextRows;
			for (const listener of [...resizeListeners]) listener();
		},
	};
}

/** A fully deterministic bundle, with any subset replaced. */
export function createFakeCapabilities(overrides?: HarnessCapabilityOverrides): HarnessCapabilities {
	return {
		clock: createFakeClock(),
		fs: createFakeFileSystem(),
		process: createFakeProcesses(),
		credentials: createFakeCredentials(),
		browser: fakeBrowser,
		transcription: fakeTranscription,
		terminal: createFakeTerminalTransport(),
		...overrides,
	};
}
