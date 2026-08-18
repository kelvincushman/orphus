import type { TerminalTransport } from "@b9g/termdom";

export interface FakeTerminalTransport extends Omit<TerminalTransport, "closed"> {
	readonly closed: Promise<{ reason?: string }>;
	/** Everything written to the terminal, in order. */
	readonly frames: string[];
	/** All output concatenated — the input to an ANSI assertion. */
	output(): string;
	/** Feed input as if typed. */
	type(data: string): void;
	resize(cols: number, rows: number): void;
	/** End the session, as a hangup would. */
	hangup(): void;
}

/**
 * A deterministic terminal.
 *
 * termDOM takes its whole notion of a terminal — size, color depth, input,
 * resizes, lifecycle — from a transport, so injecting this one makes the
 * renderer testable headlessly: real layout, real ANSI, no TTY and no timing.
 */
export function createFakeTerminalTransport(options?: {
	cols?: number;
	rows?: number;
	interactive?: boolean;
	sharesScreen?: boolean;
}): FakeTerminalTransport {
	const frames: string[] = [];
	let cols = options?.cols ?? 100;
	let rows = options?.rows ?? 30;

	let pushInput: ((chunk: string) => void) | undefined;
	let closeInput: (() => void) | undefined;
	const readable = new ReadableStream<string>({
		start(controller) {
			pushInput = (chunk) => controller.enqueue(chunk);
			closeInput = () => {
				try {
					controller.close();
				} catch {
					// Already closed by a prior hangup.
				}
			};
		},
	});

	let pushResize: ((size: { cols: number; rows: number }) => void) | undefined;
	const resizes = new ReadableStream<{ cols: number; rows: number }>({
		start(controller) {
			pushResize = (size) => controller.enqueue(size);
		},
	});

	const writable = new WritableStream<string>({
		write(chunk) {
			frames.push(chunk);
		},
	});

	let resolveClosed: (info: { reason?: string }) => void = () => {};
	const closedPromise = new Promise<{ reason?: string }>((resolve) => {
		resolveClosed = resolve;
	});

	const transport = {
		get cols() {
			return cols;
		},
		get rows() {
			return rows;
		},
		colorDepth: 24,
		readable,
		writable,
		resizes,
		sharesScreen: options?.sharesScreen ?? false,
		interactive: options?.interactive ?? true,
		ready: Promise.resolve(),
		close: (info?: { reason?: string }) => {
			closeInput?.();
			resolveClosed(info ?? { reason: "closed" });
		},
		frames,
		output: () => frames.join(""),
		type: (data: string) => pushInput?.(data),
		resize: (nextCols: number, nextRows: number) => {
			cols = nextCols;
			rows = nextRows;
			pushResize?.({ cols, rows });
		},
		hangup: () => {
			closeInput?.();
			resolveClosed({ reason: "hangup" });
		},
	};
	Object.defineProperty(transport, "closed", {
		get: () => closedPromise,
		enumerable: true,
	});
	return transport as unknown as FakeTerminalTransport;
}
