import { rm } from "node:fs/promises";
import type { ProcessCapability } from "../../core/capabilities/index.ts";
import { CdpClient, type CdpTransport, createWebSocketTransport } from "./cdp-client.ts";
import {
	type LaunchChromeOptions,
	type LaunchedChrome,
	launchIsolatedChrome,
	resolveChromeExecutable,
} from "./chrome-launcher.ts";
import { type AttachedPage, attachNewPage } from "./page-session.ts";
import { type CleanupReport, ResourceRegistry } from "./resource-registry.ts";

export interface BrowserSessionOptions {
	processes: ProcessCapability;
	/** Explicit Chrome path. Falls back to the per-platform candidates. */
	executablePath?: string;
	headless?: boolean;
	/** Disable Chrome's process sandbox. Only for a container that runs as root. */
	noSandbox?: boolean;
	/** Injected for tests. Defaults to launching a real isolated Chrome. */
	launch?: (options: LaunchChromeOptions) => Promise<LaunchedChrome>;
	/** Injected for tests. Defaults to a real WebSocket to the DevTools endpoint. */
	connect?: (url: string) => Promise<CdpTransport>;
	/** Injected for tests. Defaults to removing the throwaway profile directory. */
	removeProfileDir?: (path: string) => Promise<void>;
	/** How long to wait after each kill signal before escalating or reporting. */
	killGraceMs?: number;
	/**
	 * How long Chrome gets to expose its DevTools endpoint. Defaults to the
	 * launcher's own budget, which is sized for a person waiting on a browser.
	 * A loaded CI runner is not that, so the real-Chrome smoke test raises it.
	 */
	startupTimeoutMs?: number;
}

/**
 * One browser per agent session, owned by the harness.
 *
 * Every `browser` tool action shares this session: opening a page, clicking in
 * it, and reading it back are the same browser, which is the only way a
 * multi-step task on a site works at all. The session never attaches to an
 * existing Chrome and never touches the user's profile — it launches its own
 * with a throwaway `--user-data-dir` (see `chrome-launcher.ts`).
 */
export class BrowserSession {
	private readonly options: BrowserSessionOptions;
	private readonly registry = new ResourceRegistry();
	private starting: Promise<AttachedPage> | undefined;
	private client: CdpClient | undefined;
	private page: AttachedPage | undefined;
	private launched: LaunchedChrome | undefined;

	constructor(options: BrowserSessionOptions) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.client !== undefined && !this.client.isClosed;
	}

	/** Resources still registered. Zero after a completed `close()`. */
	get openResourceCount(): number {
		return this.registry.size;
	}

	/** Start the browser if it is not already up. Concurrent callers share one launch. */
	start(signal?: AbortSignal): Promise<AttachedPage> {
		if (this.page && this.client && !this.client.isClosed) return Promise.resolve(this.page);
		this.starting ??= this.launch(signal).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async launch(signal?: AbortSignal): Promise<AttachedPage> {
		const executablePath = this.options.executablePath ?? resolveChromeExecutable();
		if (!executablePath) {
			throw new Error(
				"No Chrome or Chromium executable found. Install one, or set ORPHUS_BROWSER_EXECUTABLE to its path.",
			);
		}
		const launch = this.options.launch ?? launchIsolatedChrome;
		const connect = this.options.connect ?? ((url: string) => createWebSocketTransport(url, { signal }));
		const removeProfileDir = this.options.removeProfileDir ?? removeDirWithStragglerRetry;

		const launched = await launch({
			processes: this.options.processes,
			executablePath,
			headless: this.options.headless,
			noSandbox: this.options.noSandbox,
			startupTimeoutMs: this.options.startupTimeoutMs,
			signal,
		});
		this.launched = launched;
		// Register teardown in the order it must be undone: the profile directory
		// can only go once the process that holds it is gone, and the registry
		// releases newest-first.
		this.registry.register("chrome profile directory", () => removeProfileDir(launched.userDataDir));
		this.registry.register("chrome process", async () => {
			// Bounded, twice: cleanup is documented to *report* a kill that did not
			// take, and an unbounded await can never report. SIGTERM gets a grace
			// period, SIGKILL gets one more, and a process still alive after both
			// is a failure the registry records rather than a shutdown that hangs.
			const grace = this.options.killGraceMs ?? 5_000;
			launched.handle.kill("SIGTERM");
			if (await exitedWithin(launched.handle, grace)) return;
			launched.handle.kill("SIGKILL");
			if (await exitedWithin(launched.handle, grace)) return;
			throw new Error(`Chrome (pid ${launched.handle.pid ?? "unknown"}) did not exit after SIGKILL`);
		});

		try {
			const transport = await connect(launched.webSocketDebuggerUrl);
			const client = new CdpClient({ transport });
			this.registry.register("devtools connection", () => client.close("session shutdown"));
			this.client = client;
			// The default connection addresses the browser, where Page.* and Runtime.*
			// do not exist. Open one page and attach to it; everything else runs there.
			const page = await attachNewPage(client);
			this.page = page;
			return page;
		} catch (error) {
			// Chrome is already running; a failure past this point must not leave it
			// (and its profile) alive for the rest of the session while the next
			// `open` spawns another one beside it.
			await this.registry.release();
			this.client = undefined;
			this.launched = undefined;
			throw error;
		}
	}

	/** The attached page, or a clear error rather than a silent auto-start. */
	require(): AttachedPage {
		if (!this.page || !this.client || this.client.isClosed) {
			throw new Error("The browser is not open. Run the `open` action first.");
		}
		return this.page;
	}

	get debuggerUrl(): string | undefined {
		return this.launched?.webSocketDebuggerUrl;
	}

	/**
	 * Tear everything down and report what failed.
	 *
	 * Every registered cleanup is attempted and awaited; the registry is empty
	 * afterwards. Failures are returned rather than swallowed — a kill that did
	 * not take is worth saying out loud.
	 */
	async close(): Promise<CleanupReport> {
		// A launch in flight registers its Chrome, profile, and connection as it
		// goes. Releasing before it finishes would report an empty registry as
		// success while the browser it is about to register outlives the session.
		await this.starting?.catch(() => undefined);
		const report = await this.registry.release();
		this.page = undefined;
		this.client = undefined;
		this.launched = undefined;
		return report;
	}
}

/**
 * Remove the throwaway profile, tolerating Chrome's own stragglers.
 *
 * The kill waits on the main process, but Chrome's helper processes can outlive
 * it by a beat and write into the profile while it is being removed — `rm`
 * then fails with ENOTEMPTY on a directory it just emptied. One short retry
 * covers the straggler; a directory still held after that is reported.
 */
export async function removeDirWithStragglerRetry(
	path: string,
	remove: (path: string) => Promise<void> = (target) => rm(target, { recursive: true, force: true }),
): Promise<void> {
	try {
		await remove(path);
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await remove(path);
	}
}

/** True when the process exits inside the window; false says "still running". */
function exitedWithin(handle: LaunchedChrome["handle"], ms: number): Promise<boolean> {
	return Promise.race([
		handle.exited.then(() => true),
		new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(false), ms).unref?.();
		}),
	]);
}
