import type { CdpTransport } from "../../packages/coding-agent/src/extensions/browser/cdp-client.js";

export interface SentCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

export interface FakeCdpTransport extends CdpTransport {
	/** Everything the client sent, decoded. */
	readonly sent: SentCommand[];
	/** Answer a command by id. */
	reply(id: number, result: Record<string, unknown>): void;
	/** Answer a command with a protocol error. */
	replyError(id: number, error: { code: number; message: string; data?: string }): void;
	/** Deliver a CDP event, optionally tagged with its originating target session. */
	emit(method: string, params?: Record<string, unknown>, sessionId?: string): void;
	/** Deliver a frame verbatim, including malformed ones. */
	deliver(raw: string): void;
	/** Simulate the far end going away. */
	drop(reason?: string): void;
	readonly closed: boolean;
}

export type FakeCdpHandler = (
	params: Record<string, unknown>,
	emit: (method: string, eventParams?: Record<string, unknown>) => void,
) => Record<string, unknown>;

/**
 * Target attach, which every session performs before it can touch a page.
 * Answered by default so a test only scripts the commands it cares about.
 */
export const DEFAULT_TARGET_HANDLERS: Record<string, FakeCdpHandler> = {
	"Target.createTarget": () => ({ targetId: "target-1" }),
	"Target.attachToTarget": () => ({ sessionId: "session-1" }),
	"Target.closeTarget": () => ({ success: true }),
	"Page.enable": () => ({}),
	// A real browser fires `load` after a navigation; a fake that never does
	// would make every navigation wait out its load budget.
	"Page.navigate": (_params, emit) => {
		queueMicrotask(() => emit("Page.loadEventFired", { timestamp: 1 }));
		return { frameId: "frame-1" };
	},
};

/**
 * A CDP transport that answers from the test rather than from Chrome. Every
 * browser test that is not a real-Chrome smoke test runs on this.
 */
export function createFakeCdpTransport(options?: {
	/** Auto-answer commands by method. Anything unhandled waits for an explicit reply. */
	handlers?: Record<string, FakeCdpHandler>;
	/** Drop the default target-attach answers, to test a browser that will not attach. */
	withoutTargetHandlers?: boolean;
}): FakeCdpTransport {
	const handlers = {
		...(options?.withoutTargetHandlers ? {} : DEFAULT_TARGET_HANDLERS),
		...options?.handlers,
	};
	const sent: SentCommand[] = [];
	const messageListeners = new Set<(payload: string) => void>();
	const closeListeners = new Set<(reason?: string) => void>();
	let closed = false;

	const deliver = (raw: string) => {
		for (const listener of [...messageListeners]) listener(raw);
	};
	const emit = (method: string, params?: Record<string, unknown>, sessionId?: string) =>
		deliver(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }));

	return {
		sent,
		get closed() {
			return closed;
		},
		send(payload) {
			const parsed = JSON.parse(payload) as SentCommand;
			sent.push(parsed);
			const handler = handlers[parsed.method];
			if (handler) {
				// Answer on a later microtask, like a real socket would. Events a
				// handler emits carry the command's session, like a real target's do.
				const emitForCommand = (method: string, eventParams?: Record<string, unknown>) =>
					emit(method, eventParams, parsed.sessionId);
				queueMicrotask(() => {
					try {
						deliver(JSON.stringify({ id: parsed.id, result: handler(parsed.params ?? {}, emitForCommand) }));
					} catch (error) {
						deliver(
							JSON.stringify({
								id: parsed.id,
								error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
							}),
						);
					}
				});
			}
		},
		onMessage: (listener) => messageListeners.add(listener),
		onClose: (listener) => closeListeners.add(listener),
		close() {
			closed = true;
		},
		reply: (id, result) => deliver(JSON.stringify({ id, result })),
		replyError: (id, error) => deliver(JSON.stringify({ id, error })),
		emit,
		deliver,
		drop(reason) {
			closed = true;
			for (const listener of [...closeListeners]) listener(reason);
		},
	};
}

/** A `Runtime.evaluate` handler that returns `values[expression-match]`. */
export function evaluateHandler(resolve: (expression: string) => unknown): FakeCdpHandler {
	return (params) => ({ result: { value: resolve(String(params.expression ?? "")) } });
}
