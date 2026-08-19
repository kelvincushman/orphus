import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessCapability, ProcessExit, ProcessHandle } from "../../core/capabilities/index.ts";

/**
 * Chrome flags that make this instance ours and only ours.
 *
 * `--user-data-dir` points at a throwaway profile created per session. That is
 * the load-bearing one: without it Chrome would attach to (or refuse to start
 * beside) the user's real profile, and browser operation would be driving a
 * browser holding the user's live sessions and cookies. Everything else here
 * exists to stop a fresh profile from opening dialogs nobody is there to close.
 */
export const ISOLATION_FLAGS: readonly string[] = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--disable-client-side-phishing-detection",
	"--disable-default-apps",
	"--disable-sync",
	"--metrics-recording-only",
	"--no-service-autorun",
	"--password-store=basic",
	"--use-mock-keychain",
];

/** Executable names and paths tried in order, per platform. */
export function chromeCandidates(platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		];
	}
	if (platform === "win32") {
		return [
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		];
	}
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/opt/pw-browsers/chromium",
	];
}

/** Resolve a Chrome executable, honouring an explicit override first. */
export function resolveChromeExecutable(options?: {
	override?: string;
	platform?: NodeJS.Platform;
	exists?: (path: string) => boolean;
}): string | undefined {
	const exists = options?.exists ?? existsSync;
	const override = options?.override?.trim();
	if (override) return exists(override) ? override : undefined;
	return chromeCandidates(options?.platform).find((candidate) => exists(candidate));
}

export interface LaunchedChrome {
	handle: ProcessHandle;
	/** The DevTools WebSocket endpoint this instance is listening on. */
	webSocketDebuggerUrl: string;
	/** The throwaway profile directory. Removing it is part of session cleanup. */
	userDataDir: string;
	port: number;
}

export interface LaunchChromeOptions {
	processes: ProcessCapability;
	executablePath: string;
	/** Fixed debugging port. Defaults to a free port chosen before launch. */
	port?: number;
	/** Injected for tests. Defaults to binding port 0 and reading back what the OS gave us. */
	choosePort?: () => Promise<number>;
	headless?: boolean;
	/** Disable Chrome's process sandbox. Only for a container that runs as root. */
	noSandbox?: boolean;
	signal?: AbortSignal;
	/** Injected for tests. Defaults to fetching `/json/version` from the DevTools endpoint. */
	readDebuggerUrl?: (port: number, signal?: AbortSignal) => Promise<string>;
	/** Injected for tests. Defaults to a real temp directory. */
	createProfileDir?: () => Promise<string>;
	/** Injected for tests. Defaults to removing the profile directory. */
	removeProfileDir?: (path: string) => Promise<void>;
	/** How long to wait for the DevTools endpoint to answer. */
	startupTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/** Bind port 0, read back what the OS handed out, and release it for Chrome. */
async function chooseFreePort(): Promise<number> {
	const { createServer } = await import("node:net");
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("Could not reserve a debugging port"))));
		});
	});
}

async function fetchDebuggerUrl(port: number, signal?: AbortSignal): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });
	if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`);
	const body = (await response.json()) as { webSocketDebuggerUrl?: string };
	if (!body.webSocketDebuggerUrl) throw new Error("DevTools endpoint did not report a WebSocket URL");
	return body.webSocketDebuggerUrl;
}

/**
 * Launch an isolated Chrome and wait for its DevTools endpoint.
 *
 * The launch is never silently retried: if the endpoint does not come up inside
 * the startup budget the process is killed and the profile removed, so a failed
 * launch does not leave a half-started browser behind.
 */
function describeExit(status: ProcessExit | undefined): string {
	if (!status) return "exit status unavailable";
	if (status.signal) return `killed by ${status.signal}`;
	return status.code === null ? "no exit code reported" : `exit code ${status.code}`;
}

export async function launchIsolatedChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
	const createProfileDir = options.createProfileDir ?? (() => mkdtemp(join(tmpdir(), "orphus-browser-")));
	const removeProfileDir = options.removeProfileDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
	const readDebuggerUrl = options.readDebuggerUrl ?? fetchDebuggerUrl;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
	const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
	const port = options.port ?? (await (options.choosePort ?? chooseFreePort)());

	const userDataDir = await createProfileDir();
	const args = [
		`--user-data-dir=${userDataDir}`,
		`--remote-debugging-port=${port}`,
		...ISOLATION_FLAGS,
		...(options.headless === false ? [] : ["--headless=new"]),
		...(options.noSandbox ? ["--no-sandbox"] : []),
		"about:blank",
	];
	const handle = options.processes.spawn(options.executablePath, args, { signal: options.signal });

	let exited = false;
	let exitStatus: ProcessExit | undefined;
	void handle.exited.then((status) => {
		exited = true;
		exitStatus = status;
	});

	const deadline = Date.now() + startupTimeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline && !exited) {
		try {
			const webSocketDebuggerUrl = await readDebuggerUrl(port, options.signal);
			return { handle, webSocketDebuggerUrl, userDataDir, port };
		} catch (error) {
			lastError = error;
			await sleep(100);
		}
	}

	handle.kill("SIGKILL");
	await removeProfileDir(userDataDir).catch(() => {});
	// When Chrome died, its own exit status is the diagnosis and the poller's
	// last error is only the symptom — "fetch failed" describes our probe, not
	// the browser. A signal separates an environment that killed Chrome (SIGKILL
	// on a memory-starved runner) from Chrome refusing to start (a code).
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(
		exited
			? `Chrome exited before its DevTools endpoint came up (${describeExit(exitStatus)})`
			: `Chrome did not expose a DevTools endpoint within ${startupTimeoutMs}ms${detail}`,
	);
}
