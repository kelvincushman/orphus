export interface CdpSocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: "message" | "close" | "error", cb: (ev: { data?: string }) => void): void;
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };
const defaultFactory = (url: string): CdpSocket => new WebSocket(url) as unknown as CdpSocket;

export class CdpConnection {
	private id = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly subs = new Map<string, ((p: Record<string, unknown>) => void)[]>();
	private constructor(private readonly socket: CdpSocket) {}

	static async open(wsUrl: string, factory: (url: string) => CdpSocket = defaultFactory): Promise<CdpConnection> {
		const socket = factory(wsUrl);
		const conn = new CdpConnection(socket);
		socket.addEventListener("message", (ev) => conn.onMessage(ev.data ?? ""));
		socket.addEventListener("close", () => conn.failAll(new Error("CDP connection closed")));
		return conn;
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.id;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async *subscribe(method: string): AsyncIterable<Record<string, unknown>> {
		const queue: Record<string, unknown>[] = [];
		let notify: (() => void) | null = null;
		const push = (p: Record<string, unknown>): void => { queue.push(p); notify?.(); };
		const list = this.subs.get(method) ?? [];
		list.push(push);
		this.subs.set(method, list);
		for (;;) {
			if (queue.length === 0) await new Promise<void>((r) => { notify = r; });
			while (queue.length) yield queue.shift() as Record<string, unknown>;
		}
	}

	private onMessage(raw: string): void {
		const msg = JSON.parse(raw) as { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown> };
		if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
			else p.resolve(msg.result ?? {});
			return;
		}
		if (msg.method) for (const cb of this.subs.get(msg.method) ?? []) cb(msg.params ?? {});
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	close(): void { this.socket.close(); }
}
