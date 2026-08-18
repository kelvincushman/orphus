/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Only what browser operation needs: correlated request/response, event
 * subscription, and a clean close. The transport is injected, so the whole
 * client is exercised model-free and Chrome-free by a scripted fake.
 */

export interface CdpTransport {
	send(payload: string): void;
	onMessage(listener: (payload: string) => void): void;
	onClose(listener: (reason?: string) => void): void;
	close(): void;
}

export interface CdpError {
	code: number;
	message: string;
	data?: string;
}

export class CdpProtocolError extends Error {
	readonly code: number;
	readonly data?: string;
	constructor(method: string, error: CdpError) {
		super(`${method} failed: ${error.message}${error.data ? ` (${error.data})` : ""}`);
		this.name = "CdpProtocolError";
		this.code = error.code;
		this.data = error.data;
	}
}

interface PendingCall {
	method: string;
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

export interface CdpClientOptions {
	transport: CdpTransport;
	/** Per-command timeout. A command that never answers must not hang a turn. */
	timeoutMs?: number;
	/** Injected so the client is deterministic under a fake clock. */
	setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultTimer(callback: () => void, ms: number): { cancel(): void } {
	const handle = setTimeout(callback, ms);
	// Never hold the process open for a browser command.
	handle.unref?.();
	return { cancel: () => clearTimeout(handle) };
}

export class CdpClient {
	private readonly transport: CdpTransport;
	private readonly timeoutMs: number;
	private readonly setTimer: NonNullable<CdpClientOptions["setTimer"]>;
	private readonly pending = new Map<number, PendingCall>();
	private readonly listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();
	private readonly onceWaiters = new Set<(error: Error) => void>();
	private nextId = 1;
	private closedReason: string | undefined;

	constructor(options: CdpClientOptions) {
		this.transport = options.transport;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.setTimer = options.setTimer ?? defaultTimer;
		this.transport.onMessage((payload) => this.handleMessage(payload));
		this.transport.onClose((reason) => this.handleClose(reason));
	}

	get isClosed(): boolean {
		return this.closedReason !== undefined;
	}

	/** Issue a CDP command and await its result. */
	send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
		if (this.closedReason) return Promise.reject(new Error(`Browser connection closed: ${this.closedReason}`));
		const id = this.nextId++;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			// Register before arming: `setTimer` is injectable, and a timer that
			// fires synchronously must find the pending call, not race its creation.
			let timer: { cancel(): void } | undefined;
			this.pending.set(id, {
				method,
				resolve: (result) => {
					timer?.cancel();
					resolve(result);
				},
				reject: (error) => {
					timer?.cancel();
					reject(error);
				},
			});
			timer = this.setTimer(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			// A synchronous settle (a fake transport, a sync timer) ran before the
			// timer handle existed; don't leave its timer armed.
			if (!this.pending.has(id)) timer.cancel();
			this.transport.send(
				JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }),
			);
		});
	}

	/**
	 * Subscribe to a CDP event. Returns an unsubscribe function. With
	 * `flatten: true`, every attached target's events share this connection;
	 * the listener's second argument is the originating target session, so a
	 * caller can tell whose event it received.
	 */
	on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
		const set = this.listeners.get(method) ?? new Set();
		set.add(listener);
		this.listeners.set(method, set);
		return () => {
			set.delete(listener);
		};
	}

	/**
	 * Resolve when `method` fires — for `sessionId`'s target when given, so a
	 * page never resolves on another page's event — reject on timeout or close.
	 */
	once(method: string, timeoutMs = this.timeoutMs, sessionId?: string): Promise<Record<string, unknown>> {
		if (this.closedReason) return Promise.reject(new Error(`Browser connection closed: ${this.closedReason}`));
		return new Promise((resolve, reject) => {
			// Listener first, timer second: a synchronously-firing injected timer
			// must find `unsubscribe` initialized, not a temporal dead zone.
			let timer: { cancel(): void } | undefined;
			const settle = (outcome: () => void) => {
				timer?.cancel();
				unsubscribe();
				this.onceWaiters.delete(fail);
				outcome();
			};
			const fail = (error: Error) => settle(() => reject(error));
			const unsubscribe = this.on(method, (params, eventSessionId) => {
				if (sessionId !== undefined && eventSessionId !== sessionId) return;
				settle(() => resolve(params));
			});
			// Waiters are settled by `handleClose` too: an event that can no longer
			// arrive should reject with the close reason now, not a timeout later.
			this.onceWaiters.add(fail);
			timer = this.setTimer(() => fail(new Error(`Timed out waiting for ${method}`)), timeoutMs);
		});
	}

	close(reason = "closed by client"): void {
		this.handleClose(reason);
		this.transport.close();
	}

	private handleMessage(payload: string): void {
		let message: {
			id?: number;
			method?: string;
			params?: Record<string, unknown>;
			result?: Record<string, unknown>;
			error?: CdpError;
			sessionId?: string;
		};
		try {
			message = JSON.parse(payload);
		} catch {
			// A frame we cannot parse is not a frame we can correlate; dropping it is
			// safer than guessing which pending call it belongs to.
			return;
		}
		if (typeof message.id === "number") {
			const call = this.pending.get(message.id);
			if (!call) return;
			this.pending.delete(message.id);
			if (message.error) call.reject(new CdpProtocolError(call.method, message.error));
			else call.resolve(message.result ?? {});
			return;
		}
		if (typeof message.method === "string") {
			for (const listener of this.listeners.get(message.method) ?? []) {
				listener(message.params ?? {}, message.sessionId);
			}
		}
	}

	private handleClose(reason?: string): void {
		if (this.closedReason) return;
		this.closedReason = reason ?? "connection closed";
		const failure = new Error(`Browser connection closed: ${this.closedReason}`);
		for (const call of this.pending.values()) call.reject(failure);
		this.pending.clear();
		for (const fail of [...this.onceWaiters]) fail(failure);
		this.listeners.clear();
	}
}

/** A CDP transport over a WebSocket. Used against a real isolated Chrome. */
export function createWebSocketTransport(
	url: string,
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CdpTransport> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const messageListeners = new Set<(payload: string) => void>();
		const closeListeners = new Set<(reason?: string) => void>();
		let open = false;
		// A socket stuck in CONNECTING settles nothing on its own, and this await
		// sits inside the `open` tool action — it must not be able to hang a turn.
		// Latched: closing the socket fires its own "error" event, which lands
		// right back here.
		let settled = false;
		const fail = (message: string) => {
			if (open || settled) return;
			settled = true;
			connectTimer.cancel();
			socket.close();
			reject(new Error(message));
		};
		const connectTimer = defaultTimer(
			() => fail(`Timed out connecting to the browser at ${url}`),
			options?.timeoutMs ?? 15_000,
		);
		options?.signal?.addEventListener("abort", () => fail(`Connecting to the browser at ${url} was aborted`), {
			once: true,
		});

		socket.addEventListener("message", (event: MessageEvent) => {
			const data = typeof event.data === "string" ? event.data : String(event.data);
			for (const listener of messageListeners) listener(data);
		});
		socket.addEventListener("close", (event: CloseEvent) => {
			for (const listener of closeListeners) listener(event.reason || `code ${event.code}`);
		});
		socket.addEventListener("error", () => {
			fail(`Failed to connect to the browser at ${url}`);
		});
		socket.addEventListener("open", () => {
			open = true;
			connectTimer.cancel();
			resolve({
				send: (payload) => socket.send(payload),
				onMessage: (listener) => messageListeners.add(listener),
				onClose: (listener) => closeListeners.add(listener),
				close: () => socket.close(),
			});
		});
	});
}
