/**
 * The cleanup ledger for a browser session.
 *
 * Every resource that outlives a single call — the Chrome process, the CDP
 * socket, the temporary profile directory — registers its teardown here. On
 * shutdown *every* registered cleanup is attempted and awaited, in reverse
 * registration order, and the registry is emptied.
 *
 * What this does not do is promise zero orphans. A kill can fail, a directory
 * can be locked, a process can already be gone. `release()` reports what failed
 * rather than swallowing it, because "we tried everything and two of them
 * failed" is a true statement a user can act on and "no orphans" is not.
 */

export interface CleanupFailure {
	label: string;
	error: string;
}

export interface CleanupReport {
	attempted: number;
	failures: CleanupFailure[];
}

export class ResourceRegistry {
	private entries: { label: string; cleanup: () => void | Promise<void> }[] = [];
	private releasing: Promise<CleanupReport> | undefined;

	get size(): number {
		return this.entries.length;
	}

	register(label: string, cleanup: () => void | Promise<void>): void {
		if (this.releasing) throw new Error(`Cannot register "${label}": the browser session is already shutting down.`);
		this.entries.push({ label, cleanup });
	}

	/**
	 * Attempt every cleanup, newest first, and await all of them. Concurrent
	 * callers share one release: a cancel that races a shutdown must not run
	 * teardown twice.
	 */
	release(): Promise<CleanupReport> {
		// Concurrent callers share one release — a cancel racing a shutdown must
		// not run teardown twice — but a completed release leaves the registry
		// reusable, so `close` then `open` starts a fresh browser rather than
		// refusing to register anything ever again.
		this.releasing ??= this.runRelease().finally(() => {
			this.releasing = undefined;
		});
		return this.releasing;
	}

	private async runRelease(): Promise<CleanupReport> {
		const entries = this.entries.slice().reverse();
		this.entries = [];
		const failures: CleanupFailure[] = [];
		for (const entry of entries) {
			try {
				await entry.cleanup();
			} catch (error) {
				failures.push({ label: entry.label, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { attempted: entries.length, failures };
	}
}

/** Human-readable summary of a cleanup pass, or undefined when nothing failed. */
export function formatCleanupReport(report: CleanupReport): string | undefined {
	if (report.failures.length === 0) return undefined;
	const lines = report.failures.map((failure) => `  - ${failure.label}: ${failure.error}`);
	return `Browser cleanup attempted ${report.attempted} resource(s); ${report.failures.length} failed:\n${lines.join("\n")}`;
}
