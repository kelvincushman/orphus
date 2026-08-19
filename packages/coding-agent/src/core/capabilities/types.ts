/**
 * The harness capability boundary.
 *
 * Everything the harness does that touches the world outside its own process
 * state — the clock, the filesystem, child processes, the OS credential vault,
 * a browser, an audio transcription backend, a terminal — passes through one of
 * these interfaces. Production wires the real implementations
 * ({@link ./default-capabilities.ts}); tests and the replay harness wire
 * deterministic fakes ({@link ./fake-capabilities.ts}) and get the same
 * assembled runtime rather than a parallel one built for testing.
 *
 * The interfaces are deliberately narrow. A capability exposes the operations
 * the harness actually performs, not the surface of the underlying API — a
 * wider interface is a wider fake, and a fake nobody can hold in their head
 * stops being evidence about the real thing.
 */

/**
 * Every capability names its implementation. `orphus inspect runtime` reports
 * these, so "which clock is this session on" is answerable without reading the
 * wiring.
 */
export interface NamedCapability {
	readonly kind: string;
}

/** Wall-clock and monotonic time, plus cancellable sleep. */
export interface ClockCapability extends NamedCapability {
	/** Milliseconds since the Unix epoch. */
	now(): number;
	/** Monotonic milliseconds, for durations that must survive a wall-clock jump. */
	monotonicNow(): number;
	/** Resolve after `ms`, or reject with the signal's reason if aborted first. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface FileStat {
	size: number;
	/** POSIX mode bits. Always 0 on platforms that do not report them. */
	mode: number;
	isDirectory: boolean;
}

export interface WriteFileOptions {
	/** POSIX file mode. Owner-only (`0o600`) for anything derived from a session. */
	mode?: number;
	/** `node:fs` open flag. `"wx"` makes a write fail rather than clobber. */
	flag?: string;
}

/** The filesystem operations the harness performs on its own artifacts. */
export interface FileSystemCapability extends NamedCapability {
	readFile(path: string): Promise<string>;
	writeFile(path: string, data: string, options?: WriteFileOptions): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	/** Resolve to undefined when the path does not exist, rather than throwing. */
	stat(path: string): Promise<FileStat | undefined>;
	remove(path: string): Promise<void>;
}

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ProcessExit {
	code: number | null;
	signal: string | null;
}

/** A spawned child process. `exited` settles exactly once, and never rejects. */
export interface ProcessHandle {
	readonly pid: number | undefined;
	readonly exited: Promise<ProcessExit>;
	kill(signal?: NodeJS.Signals): void;
}

export interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface ProcessCapability extends NamedCapability {
	spawn(command: string, args: readonly string[], options?: SpawnOptions): ProcessHandle;
	/**
	 * Run a command to completion and collect its output. For short-lived
	 * helpers — a keychain lookup, a version probe — where streaming would be
	 * ceremony. Never throws on a non-zero exit; the code is part of the result.
	 */
	exec(command: string, args: readonly string[], options?: SpawnOptions): Promise<ProcessResult>;
}

/**
 * A credential the harness may hand to a subsystem without ever seeing it in
 * model-visible context. Only {@link CredentialRecord.label} is safe to log.
 */
export interface CredentialRecord {
	/** Stable, non-secret handle. This is the only field allowed into logs or context. */
	label: string;
	/** Origin the credential is scoped to, e.g. `https://example.com`. */
	origin: string;
	username?: string;
}

export interface CredentialCapability extends NamedCapability {
	list(): Promise<CredentialRecord[]>;
	/**
	 * Resolve the secret for a label. Callers must route the result straight to
	 * its destination: never into a tool result, a session entry, or a log line.
	 */
	reveal(label: string): Promise<string | undefined>;
}

/**
 * Browser operation. Implemented in the browser stage; declared here so the
 * capability bundle has one shape and `inspect runtime` can report which
 * implementation is wired before the feature exists.
 */
export interface BrowserCapability extends NamedCapability {
	/** Whether this build/runtime can actually operate a browser right now. */
	isAvailable(): boolean;
}

/** Local speech-to-text. Implemented in the transcription stage. */
export interface TranscriptionCapability extends NamedCapability {
	isAvailable(): boolean;
}

/**
 * The terminal a renderer attaches to: stdin/stdout, raw mode, size, and
 * resize notification. A deterministic implementation makes headless frame and
 * ANSI assertions possible without a TTY.
 */
export interface TerminalTransportCapability extends NamedCapability {
	readonly isTTY: boolean;
	columns(): number;
	rows(): number;
	write(data: string): void;
	setRawMode(enabled: boolean): void;
	onData(listener: (chunk: string) => void): () => void;
	onResize(listener: () => void): () => void;
}

/**
 * The full bundle. Held by the session runtime and passed to subsystems rather
 * than reached for as module globals.
 */
export interface HarnessCapabilities {
	clock: ClockCapability;
	fs: FileSystemCapability;
	process: ProcessCapability;
	credentials: CredentialCapability;
	browser: BrowserCapability;
	transcription: TranscriptionCapability;
	terminal: TerminalTransportCapability;
}

/** Every capability is individually replaceable; unspecified ones keep the default. */
export type HarnessCapabilityOverrides = Partial<HarnessCapabilities>;
