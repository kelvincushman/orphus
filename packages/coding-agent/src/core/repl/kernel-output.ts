/**
 * What a kernel says back, and how much of it the agent pays for.
 *
 * A kernel exists so a 4 MB file can live in a variable instead of a context
 * window. That saving is undone the moment `exec` returns 4 MB of output, so
 * the boundary is bounded from the first commit rather than after someone
 * notices.
 *
 * There are two bounds and they are not the same one twice:
 *
 * 1. **This module** keeps a rolling buffer per kernel and returns a capped
 *    view. It exists so the *process* cannot exhaust memory by printing
 *    forever, and so `peek` has something to show.
 * 2. **`redirectOversizedToolResult`** already runs on every tool result and
 *    spills anything oversized to a file, replacing it with a pointer. That is
 *    the bound that protects the context window, and the `repl` tool gets it
 *    for free by being an ordinary tool.
 *
 * The second bound is why this module caps rather than truncates silently: it
 * must not quietly hand back something small enough to slip under the spill
 * threshold while claiming to be the whole output. What it drops, it says.
 */

/** How much of a kernel's output the rolling buffer retains. */
export const KERNEL_BUFFER_CHARS = 200_000;

/** How much of it `exec` and `peek` return without being asked for more. */
export const KERNEL_VIEW_CHARS = 4_000;

export interface KernelView {
	text: string;
	/** Characters dropped from the *view*. Zero when the view is the whole buffer. */
	elidedChars: number;
	/** Characters dropped from the *buffer* since the kernel opened, because it overflowed. */
	droppedFromBuffer: number;
}

/**
 * A bounded, append-only view of one kernel's output.
 *
 * Keeps the tail rather than the head: when a REPL prints more than the buffer
 * holds, the interesting part is almost always what it said last — the error,
 * the result, the prompt — not the banner it printed on startup.
 */
export class KernelBuffer {
	private text = "";
	private dropped = 0;
	private readonly capacity: number;

	constructor(capacity: number = KERNEL_BUFFER_CHARS) {
		this.capacity = capacity;
	}

	append(chunk: string): void {
		this.text += chunk;
		if (this.text.length <= this.capacity) return;
		const overflow = this.text.length - this.capacity;
		this.text = this.text.slice(overflow);
		this.dropped += overflow;
	}

	/** Everything retained. Used by callers that are about to spill it to a file. */
	full(): string {
		return this.text;
	}

	get droppedChars(): number {
		return this.dropped;
	}

	clear(): void {
		this.text = "";
	}

	/**
	 * The tail, capped, with the elision counted rather than implied.
	 *
	 * A view that silently dropped characters would be indistinguishable from a
	 * short output — and the agent would reason about a truncated result
	 * believing it complete, which is the failure this whole phase is arranged
	 * against.
	 */
	view(limit: number = KERNEL_VIEW_CHARS): KernelView {
		if (this.text.length <= limit) {
			return { text: this.text, elidedChars: 0, droppedFromBuffer: this.dropped };
		}
		return {
			text: this.text.slice(this.text.length - limit),
			elidedChars: this.text.length - limit,
			droppedFromBuffer: this.dropped,
		};
	}
}

/**
 * Render a view for the model, stating every elision.
 *
 * `fullOutputPath` is included when the caller has spilled the untruncated
 * output somewhere readable — the pointer is what makes the bound honest, since
 * it converts "you cannot see this" into "you can go and read this".
 */
export function formatKernelView(view: KernelView, options: { fullOutputPath?: string } = {}): string {
	const notes: string[] = [];
	if (view.elidedChars > 0) notes.push(`${view.elidedChars} earlier character(s) not shown`);
	if (view.droppedFromBuffer > 0) {
		notes.push(`${view.droppedFromBuffer} character(s) scrolled out of the kernel's buffer and are unrecoverable`);
	}
	if (options.fullOutputPath) notes.push(`full output: ${options.fullOutputPath}`);

	if (notes.length === 0) return view.text;
	return `${view.text}\n[${notes.join("; ")}]`;
}

/**
 * The one-line acknowledgement that makes a kernel worth having.
 *
 * `docs = open('big.json').read()` should cost the agent this, not the file.
 * Callers use it when the executed code produced no output worth showing.
 */
export function formatQuietResult(kernelName: string, elapsedMs: number): string {
	return `ok (${kernelName}, ${elapsedMs}ms, no output)`;
}
