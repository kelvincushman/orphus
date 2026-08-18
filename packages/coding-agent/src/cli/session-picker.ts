/**
 * Session selector for `--resume`.
 *
 * The renderer is chosen at call time — `ORPHUS_TUI_BACKEND`, then the
 * `tui.backend` setting, then the release default (`pi`). Whichever runs, its
 * host is disposed and that disposal awaited before this function returns, so
 * the terminal is fully handed back before the chat UI attaches.
 */

import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { createSelectorHost } from "../core/terminal/index.ts";
import { SessionSelectorModel } from "../core/terminal/session-selector-model.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show the session selector and return the selected session path, or null if cancelled. */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	options?: { settingsManager?: SettingsManager; currentSessionPath?: string },
): Promise<string | null> {
	const { host, warning } = await createSelectorHost({
		setting: options?.settingsManager?.getTuiBackend(),
	});
	if (warning) console.error(warning);

	const model = new SessionSelectorModel({ currentSessionPath: options?.currentSessionPath });
	try {
		const result = await host.selectSession({
			model,
			loadCurrentSessions: currentSessionsLoader,
			loadAllSessions: allSessionsLoader,
		});
		if (result.outcome === "selected") return result.sessionPath;
		if (result.outcome === "exit") {
			// The pi selector's third callback is a hard quit, not a cancel.
			await host.dispose();
			process.exit(0);
		}
		return null;
	} finally {
		// Awaited: raw mode, cursor, mouse reporting, and bracketed paste are
		// restored before anything else touches the terminal.
		await host.dispose();
	}
}
