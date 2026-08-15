/**
 * The adapter from a kernel to a real process.
 *
 * The native `PtySession` (`crates/atomic-natives/src/pty.rs`) already does the
 * hard part — a genuinely interactive terminal with `start/write/resize/kill`.
 * What the TS layer did with it was build one per command and throw it away
 * (`bash-pty-native.ts`). This keeps it alive, which is the entire difference
 * between `bash` and a kernel.
 *
 * Two details make that work and are easy to get wrong:
 *
 * - **`closeStdinAfterCommand: false`.** A REPL reads until stdin closes.
 *   Closing it after the launch command turns the kernel into a one-shot.
 * - **No `timeoutMs`.** The per-*exec* timeout lives in `KernelSession`; a
 *   timeout here would kill the process and every value in it.
 *
 * `start()` resolves when the process exits, so the returned promise is held,
 * not awaited — a resolved one means the kernel died.
 *
 * **Not a security sandbox.** See `docs/repl.md`.
 */

import { describeJail, type JailPlatform, jailCommand } from "./kernel-jail.js";
import type { KernelProcess } from "./kernel-registry.js";
import type { KernelLanguage } from "./kernel-session.js";

/** The launch command per language. `-q`/`-i` keep the banner small and the prompt interactive. */
export function launchCommandFor(language: KernelLanguage): { command: string; args: string[] } {
	switch (language) {
		case "python":
			// -q drops the banner; -u keeps output unbuffered so a sentinel is not
			// stuck in a pipe buffer while exec waits for it.
			return { command: "python3", args: ["-q", "-u", "-i"] };
		case "node":
			return { command: "node", args: ["-i"] };
	}
}

/** Minimal surface of the native binding this module needs. Injectable for tests. */
export interface PtySessionLike {
	start(
		options: {
			command: string;
			cwd: string;
			env: Record<string, string | undefined>;
			cols: number;
			rows: number;
			closeStdinAfterCommand: boolean;
		},
		onData: (error: unknown, chunk: Uint8Array | undefined) => void,
	): Promise<unknown>;
	write(data: string): void;
	kill(): void;
}

export interface PtyKernelOptions {
	language: KernelLanguage;
	cwd: string;
	env?: Record<string, string | undefined>;
	jail?: boolean;
	platform?: JailPlatform;
	onData: (chunk: string) => void;
	createSession: () => PtySessionLike;
	/** Called if the process exits on its own, so the registry can stop pointing at a corpse. */
	onExit?: (reason: string) => void;
}

export interface PtyKernel {
	process: KernelProcess;
	jailNote: string;
}

/**
 * Join a command and its arguments into one shell string, safely.
 *
 * `PtySession` takes a command line, not an argv, so the arguments have to
 * survive a shell. The macOS jail passes an entire `sandbox-exec` profile as a
 * single argument — a multi-line s-expression full of parentheses — and a naive
 * `join(" ")` hands the shell a syntax error that would leave the kernel
 * unjailed or dead, depending on how it mangled.
 *
 * Single quotes, with the standard `'\''` escape for embedded ones: inside
 * single quotes a POSIX shell interprets nothing at all, which is exactly the
 * property needed here.
 */
export function shellJoin(command: string, args: readonly string[]): string {
	const quote = (value: string): string => (/^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
	return [command, ...args].map(quote).join(" ");
}

/**
 * Build a live kernel process.
 *
 * The jail is opt-in and its status is *returned*, never assumed: a caller that
 * asked for a jail on a platform without one is told it did not get one, rather
 * than being left to believe it did.
 */
export function createPtyKernel(options: PtyKernelOptions): PtyKernel {
	const { command, args } = launchCommandFor(options.language);
	const jail = options.jail
		? jailCommand({
				platform: options.platform ?? "unsupported",
				workspace: options.cwd,
				command,
				args,
			})
		: { command, args: [...args], jailed: false, reason: "the jail was not requested" };

	const session = options.createSession();
	const launched = session.start(
		{
			command: shellJoin(jail.command, jail.args),
			cwd: options.cwd,
			env: { ...options.env, TERM: "dumb" },
			cols: 120,
			rows: 40,
			// A REPL reads until stdin closes. Closing it after the launch command
			// would make this a one-shot, which is exactly what a kernel is not.
			closeStdinAfterCommand: false,
		},
		(error, chunk) => {
			if (error) return;
			if (chunk) options.onData(Buffer.from(chunk).toString("utf8"));
		},
	);
	// start() resolves when the process EXITS, so this is held rather than
	// awaited. A resolved promise means the kernel is gone.
	void launched.then(
		() => options.onExit?.("the kernel process exited"),
		(error: unknown) => options.onExit?.(error instanceof Error ? error.message : String(error)),
	);

	return {
		process: {
			write: (data) => session.write(data),
			kill: () => session.kill(),
		},
		jailNote: options.jail ? describeJail(jail) : "not jailed",
	};
}
