/**
 * Running code in a live kernel and knowing when it finished.
 *
 * A REPL never tells you it is done. It prints a prompt, which is
 * indistinguishable from a program that happened to print `>>> `. So `exec`
 * writes the code followed by a statement that prints a **sentinel**, and reads
 * until the sentinel appears. That is the whole trick, and it is why a kernel
 * needs a session layer rather than just a process handle.
 *
 * Everything here takes an injected process, so the logic is tested without
 * spawning anything. The real wiring constructs the same interface over the
 * native `PtySession` (`crates/atomic-natives/src/pty.rs`), which already has
 * `start/write/resize/kill` — the TS layer previously built one per command and
 * threw it away.
 *
 * **Not a security sandbox.** See `docs/repl.md`.
 */

import { KernelBuffer, type KernelView } from "./kernel-output.js";

/** Emitted after each exec so completion is detectable rather than guessed. */
export function sentinelFor(token: string): string {
	return `__ORPHUS_KERNEL_DONE_${token}__`;
}

export type KernelLanguage = "python" | "node";

/**
 * How to make a language print the sentinel, given the code to run first.
 *
 * The sentinel is emitted as **two concatenated halves**, so the literal string
 * never appears in the source that is written to the terminal. This is not
 * decoration: a PTY echoes its input, so a script containing the whole sentinel
 * satisfies the completion check the instant it is echoed — before the code has
 * run at all. Every `exec` then returns immediately with nothing.
 *
 * A fake process cannot catch this, because a fake that echoes and then answers
 * passes for the wrong reason. The real-PTY integration test is what found it.
 */
export function execScript(language: KernelLanguage, code: string, token: string): string {
	const sentinel = sentinelFor(token);
	const split = Math.floor(sentinel.length / 2);
	const halves = `${JSON.stringify(sentinel.slice(0, split))} + ${JSON.stringify(sentinel.slice(split))}`;
	switch (language) {
		case "python":
			return `${code}\nprint(${halves})\n`;
		case "node":
			return `${code}\nconsole.log(${halves})\n`;
	}
}

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export class KernelExecTimeout extends Error {
	readonly partial: string;
	constructor(timeoutMs: number, partial: string) {
		super(`kernel did not finish within ${timeoutMs}ms`);
		this.name = "KernelExecTimeout";
		this.partial = partial;
	}
}

export class KernelBusy extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KernelBusy";
	}
}

export interface KernelProcessLike {
	write(data: string): void;
	kill(): void;
}

export interface ExecResult {
	view: KernelView;
	/** Everything the kernel printed for this exec, before any view cap. Callers spill this. */
	raw: string;
	elapsedMs: number;
	timedOut: boolean;
}

/**
 * One live kernel: a process, its buffer, and the ability to run code in it.
 *
 * The buffer is per-kernel and long-lived; `exec` additionally tracks what this
 * particular call produced, because "what did that line print" is a different
 * question from "what has this kernel said all session".
 */
export class KernelSession {
	readonly name: string;
	readonly language: KernelLanguage;
	private readonly process: KernelProcessLike;
	private readonly buffer = new KernelBuffer();
	private pending = "";
	private waiter: ((chunk: string) => void) | undefined;
	private running: string | undefined;

	constructor(options: { name: string; language: KernelLanguage; process: KernelProcessLike }) {
		this.name = options.name;
		this.language = options.language;
		this.process = options.process;
	}

	/** Feed output from the process. The real wiring calls this from the PTY data callback. */
	receive(chunk: string): void {
		this.buffer.append(chunk);
		this.pending += chunk;
		this.waiter?.(this.pending);
	}

	/** A bounded look at the kernel's output without running anything. */
	peek(limit?: number): KernelView {
		return this.buffer.view(limit);
	}

	kill(): void {
		this.process.kill();
	}

	/**
	 * Run code and wait for the sentinel.
	 *
	 * On timeout the partial output is returned rather than discarded, and the
	 * kernel is left alive: the code may still be running, and killing a kernel
	 * because one call was slow would destroy every value in it. The caller
	 * decides whether to close it.
	 */
	async exec(
		code: string,
		options: { token: string; timeoutMs?: number; now?: () => number; setTimer?: typeof setTimeout },
	): Promise<ExecResult> {
		// One execution at a time. A second exec would reset `pending` and replace
		// `waiter`, so the first promise could never settle and output from both
		// would interleave into whichever sentinel arrived first.
		if (this.running !== undefined) {
			throw new KernelBusy(`kernel '${this.name}' is already running an execution; wait for it or close the kernel`);
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
		const now = options.now ?? Date.now;
		const setTimer = options.setTimer ?? setTimeout;
		const sentinel = sentinelFor(options.token);
		const startedAt = now();

		this.running = options.token;
		this.pending = "";
		const script = execScript(this.language, code, options.token);
		this.process.write(script);

		const raw = await new Promise<string>((resolve, reject) => {
			let settled = false;
			const finish = (value: string) => {
				if (settled) return;
				settled = true;
				this.waiter = undefined;
				resolve(value);
			};
			const timer = setTimer(() => {
				if (settled) return;
				settled = true;
				this.waiter = undefined;
				// Released even though the code may still be running: the alternative
				// is a kernel that can never be used again after one slow call. The
				// stale sentinel is why tokens must be unique per execution.
				this.running = undefined;
				reject(new KernelExecTimeout(timeoutMs, stripEcho(this.pending, script, sentinel)));
			}, timeoutMs);
			(timer as { unref?: () => void }).unref?.();

			this.waiter = (accumulated) => {
				if (!accumulated.includes(sentinel)) return;
				clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
				finish(stripEcho(accumulated, script, sentinel));
			};
			// Output may already have arrived between write and this listener.
			this.waiter(this.pending);
		});

		const viewBuffer = new KernelBuffer();
		viewBuffer.append(raw);
		this.running = undefined;
		return { view: viewBuffer.view(), raw, elapsedMs: now() - startedAt, timedOut: false };
	}
}

/**
 * Remove the sentinel and the echo of everything that was written.
 *
 * A PTY echoes its input, so without this every `exec` hands back the code the
 * agent just sent — which is pure waste, and worse, it means an expression that
 * printed nothing looks like it printed something. That would defeat the one
 * line a kernel exists to produce: `ok (work, 84ms, no output)` for
 * `docs = open('big.json').read()`.
 *
 * Echoed lines are consumed **in order from the start** rather than filtered
 * globally, so a program that legitimately prints a line identical to its own
 * source still has that output returned.
 */
function stripEcho(text: string, script: string, sentinel: string): string {
	const echoed = script.split(/\r?\n/).filter((line) => line.length > 0);
	const lines = text.split(/\r?\n/);

	let cursor = 0;
	for (const line of echoed) {
		if (cursor < lines.length && lines[cursor]?.trim() === line.trim()) cursor += 1;
	}

	return lines
		.slice(cursor)
		.filter((line) => !line.includes(sentinel))
		.join("\n")
		.replace(/\n+$/, "\n");
}
