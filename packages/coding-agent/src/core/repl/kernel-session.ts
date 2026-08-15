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
/**
 * The literal that identifies anything sentinel-related, in either form.
 *
 * The sentinel is emitted as two concatenated halves so that echoing the print
 * statement cannot satisfy the completion check. That means the echoed line
 * does **not** contain the joined sentinel — so filtering on the joined form
 * leaves `print("__ORPHUS_KERNEL_" + "DONE_x__")` in every result, and any test
 * asserting `doesNotMatch(/ORPHUS_KERNEL_DONE/)` passes while the echo leaks.
 *
 * The split is therefore pinned to exactly this prefix rather than the
 * midpoint, so this literal survives intact in both forms and one check catches
 * both.
 */
export const SENTINEL_MARKER = "__ORPHUS_KERNEL_";

export function sentinelFor(token: string): string {
	return `${SENTINEL_MARKER}DONE_${token}__`;
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
	// Split exactly after the marker, not at the midpoint: a midpoint moves with
	// the token length, so nothing stable is left for the echo filter to match.
	const halves = `${JSON.stringify(SENTINEL_MARKER)} + ${JSON.stringify(sentinel.slice(SENTINEL_MARKER.length))}`;
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
	const lines = text.split(/\r?\n/).map(stripPrompt);

	// Skip whatever is left over before the echo begins. The previous exec's
	// trailing prompt arrives as its own fragment often enough that requiring the
	// echo at position zero worked standalone and failed under load — a timing
	// dependency, which is the worst kind of correctness.
	// Consume the echoed block as many times as it appears. On a kernel's first
	// exec the write lands before the interpreter is reading, so the PTY line
	// discipline echoes the whole script AND the interpreter echoes it again with
	// prompts. Measured against a real python kernel:
	//
	//   import json                                  <- PTY echo, line 1
	//   print("__ORPHUS_KERNEL_" + "DONE_x__")       <- PTY echo, line 2
	//   >>> import json                              <- interpreter echo, line 1
	//   >>> print("__ORPHUS_KERNEL_" + "DONE_x__")   <- interpreter echo, line 2
	//   __ORPHUS_KERNEL_DONE_x__                     <- the sentinel
	//
	// Matching the block once left the second copy of the code in the answer.
	// Two shapes occur, both measured against a real python kernel, and a fix for
	// either alone breaks the other.
	//
	// FIRST exec — the write lands before the interpreter is reading, so the PTY
	// line discipline echoes the whole script and the interpreter echoes it again
	// with prompts. The block appears TWICE, back to back.
	//
	// LATER execs — one echo, but an expression's result is printed BETWEEN the
	// two echoed lines:
	//   sum(...)            <- echo, line 1
	//   7485000             <- the answer
	//   >>> print(...)      <- echo, line 2
	//
	// So: consume in order and tolerate output interleaved between echoed lines
	// (never skipping forward over it), then consume any further whole copies of
	// the block that follow immediately.
	// Three shapes occur, all measured against a live python kernel, and a fix for
	// any one alone breaks another:
	//
	//   A. FIRST exec, clean       code, print, >>> code, >>> print, sentinel
	//   B. LATER exec, interleaved code, 43, >>> print, sentinel
	//   C. FIRST exec, interleaved code, print, >>> code, 43, >>> print, sentinel
	//
	// An all-or-nothing block match handles A and consumes nothing in B or C,
	// leaving the source in the answer. A single in-order pass handles B and
	// leaves half of A. Repeating the in-order pass while it makes progress
	// handles all three: it never skips forward over output, so an answer sitting
	// between two echoed lines simply stops that pass.
	let cursor = 0;
	for (;;) {
		const next = consumeEchoedLines(lines, echoed, cursor);
		if (next === cursor) break;
		cursor = next;
	}

	return lines
		.slice(cursor)
		.filter((line) => !line.includes(sentinel) && !isSentinelEcho(line))
		.join("\n")
		.replace(/\n+$/, "\n")
		.replace(/^\n+/, "");
}

/**
 * Remove a REPL's prompt from the front of a line.
 *
 * A real terminal returns `>>> print(value)`, not `print(value)`, so echo
 * matching fails on the prompt alone and every result comes back wrapped in
 * terminal furniture. Stripping it is what makes an answer read as `42` rather
 * than as a transcript of the conversation that produced it.
 */
/**
 * Consume echoed lines in order from `cursor`, stopping at the first mismatch.
 *
 * Deliberately never skips forward over a non-matching line: that line is the
 * program's own output, and stepping past it to find a later echo would delete
 * the answer.
 */
function consumeEchoedLines(lines: readonly string[], echoed: readonly string[], cursor: number): number {
	let probe = cursor;
	for (const line of echoed) {
		while (probe < lines.length && lines[probe]?.trim() === "") probe += 1;
		if (probe >= lines.length || lines[probe]?.trim() !== line.trim()) break;
		probe += 1;
	}
	return probe;
}

function stripPrompt(line: string): string {
	return line.replace(/^(?:>>>|\.\.\.|>) ?/, "");
}

/**
 * The echoed sentinel line, which arrives in halves and so does not contain the
 * assembled sentinel to match against.
 */
function isSentinelEcho(line: string): boolean {
	return line.includes(SENTINEL_MARKER);
}
