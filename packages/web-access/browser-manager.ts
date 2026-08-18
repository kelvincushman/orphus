import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpConnection, type CdpSocket } from "./cdp/connection.js";
import { findChrome } from "./find-chrome.js";

export interface BrowserHandle {
	name: string;
	port: number;
	pid: number;
	cdp: CdpConnection;
	stop(): Promise<void>;
}

export type SpawnFn = (bin: string, args: string[]) => { pid: number; kill(sig?: string): void };

interface BrowserManagerOptions {
	maxInstances?: number;
	profileRoot?: string;
	spawn?: SpawnFn;
	wsEndpoint?: (port: number) => Promise<string>;
	connect?: (wsUrl: string) => Promise<CdpConnection>;
}

const defaultSpawn: SpawnFn = (bin, args) => {
	// This module only runs inside the Bun-compiled binary (see packages/web-access/subprocess.ts
	// for the same convention), so an unguarded Bun.spawn is safe here.
	const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	return {
		pid: proc.pid,
		kill: (sig) => {
			try {
				proc.kill(sig as NodeJS.Signals | undefined);
			} catch {
				// process may have already exited
			}
		},
	};
};

const WS_ENDPOINT_TIMEOUT_MS = 10_000;
const WS_ENDPOINT_POLL_MS = 50;

interface DevtoolsTarget {
	type: string;
	webSocketDebuggerUrl: string;
}

/**
 * Chrome does not open its DevTools port synchronously with process start, so
 * the first fetch attempt(s) after spawn routinely see ECONNREFUSED. Poll until
 * it answers or the bounded timeout elapses.
 *
 * `/json/version`'s `webSocketDebuggerUrl` is the browser-level target: it only
 * supports browser-scoped domains (Target, Browser, ...), not `Page`/`Runtime`,
 * which need an actual page target. `/json/list` enumerates targets including
 * the tab Chrome opens on startup, so pick the first `type: "page"` entry.
 */
async function defaultWsEndpoint(port: number): Promise<string> {
	const deadline = Date.now() + WS_ENDPOINT_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = (await res.json()) as DevtoolsTarget[];
			const page = targets.find((target) => target.type === "page");
			if (page) return page.webSocketDebuggerUrl;
			lastError = new Error("no page target yet");
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, WS_ENDPOINT_POLL_MS));
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(
		`Chrome DevTools page target on port ${port} did not become ready within ${WS_ENDPOINT_TIMEOUT_MS}ms: ${reason}`,
	);
}

const SOCKET_OPEN_TIMEOUT_MS = 10_000;

function waitForOpen(socket: WebSocket, wsUrl: string): Promise<WebSocket> {
	if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`WebSocket connection to ${wsUrl} did not open within ${SOCKET_OPEN_TIMEOUT_MS}ms`));
		}, SOCKET_OPEN_TIMEOUT_MS);
		const onOpen = () => {
			cleanup();
			resolve(socket);
		};
		const onError = () => {
			cleanup();
			reject(new Error(`WebSocket connection to ${wsUrl} failed`));
		};
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
		};
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
	});
}

/**
 * `CdpConnection.open` attaches its message/close listeners and returns as soon
 * as the socket is constructed, without waiting for the WebSocket handshake to
 * finish — sending on a still-CONNECTING socket throws. Open the socket here,
 * wait for it to actually be ready, then hand the already-open socket to
 * `CdpConnection.open` through its existing factory seam so Task 1's connection
 * module stays untouched.
 */
async function defaultConnect(wsUrl: string): Promise<CdpConnection> {
	const socket = new WebSocket(wsUrl);
	await waitForOpen(socket, wsUrl);
	return CdpConnection.open(wsUrl, () => socket as unknown as CdpSocket);
}

export class BrowserManager {
	private readonly instances = new Map<string, BrowserHandle>();
	private readonly max: number;
	private readonly spawn: SpawnFn;
	private readonly wsEndpoint: (port: number) => Promise<string>;
	private readonly connect: (wsUrl: string) => Promise<CdpConnection>;
	private readonly profileRoot: string;
	private nextPort = 9222;

	constructor(opts: BrowserManagerOptions = {}) {
		this.max = opts.maxInstances ?? 4;
		this.spawn = opts.spawn ?? defaultSpawn;
		this.wsEndpoint = opts.wsEndpoint ?? defaultWsEndpoint;
		this.connect = opts.connect ?? defaultConnect;
		this.profileRoot = opts.profileRoot ?? mkdtempSync(join(tmpdir(), "orphus-browser-"));
	}

	async launch(name: string): Promise<BrowserHandle> {
		const existing = this.instances.get(name);
		if (existing) return existing;
		if (this.instances.size >= this.max) {
			const err = new Error(`Browser instance cap (${this.max}) reached`);
			err.name = "CapacityExhausted";
			throw err;
		}
		const bin = findChrome();
		if (!bin) {
			const err = new Error("Chrome not found; set ORPHUS_CHROME_PATH");
			err.name = "ChromeNotFound";
			throw err;
		}
		const port = this.nextPort++;
		const profile = join(this.profileRoot, name);
		const proc = this.spawn(bin, [
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--headless=new",
		]);
		let cdp: CdpConnection;
		try {
			const wsUrl = await this.wsEndpoint(port);
			cdp = await this.connect(wsUrl);
		} catch (error) {
			// The process spawned but never made it into the registry; kill it here
			// or it leaks, unreachable by stopAll().
			try {
				proc.kill("SIGTERM");
			} catch {
				// process may have already exited
			}
			throw error;
		}
		const handle: BrowserHandle = {
			name,
			port,
			pid: proc.pid,
			cdp,
			stop: async () => {
				cdp.close();
				proc.kill("SIGTERM");
				this.instances.delete(name);
			},
		};
		this.instances.set(name, handle);
		return handle;
	}

	get(name: string): BrowserHandle | undefined {
		return this.instances.get(name);
	}

	async stopAll(): Promise<void> {
		for (const handle of [...this.instances.values()]) await handle.stop();
	}
}
