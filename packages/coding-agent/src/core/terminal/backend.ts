import type { SessionInfo, SessionListProgress } from "../session-manager.ts";
import type { SessionSelectorModel } from "./session-selector-model.ts";

export type TuiBackendName = "pi" | "termdom";

/** Environment override, highest precedence. */
export const ENV_TUI_BACKEND = "ORPHUS_TUI_BACKEND";

/**
 * The release default.
 *
 * Pi renders the main chat shell and every surface outside this pilot, and it
 * stays the default until the termDOM pilot has an opt-in release behind it.
 */
export const DEFAULT_TUI_BACKEND: TuiBackendName = "pi";

export function isTuiBackendName(value: unknown): value is TuiBackendName {
	return value === "pi" || value === "termdom";
}

export type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

export interface SessionSelectorRunOptions {
	model: SessionSelectorModel;
	/** Sessions rooted at the current working directory. */
	loadCurrentSessions: SessionsLoader;
	/** Every session across projects. Loaded lazily when the scope is switched. */
	loadAllSessions: SessionsLoader;
	/** Persist a rename. Absent when the caller does not support renaming. */
	renameSession?: (sessionPath: string, name: string) => Promise<void>;
	/** Delete a session file. Absent when the caller does not support deletion. */
	deleteSession?: (sessionPath: string) => Promise<void>;
}

/**
 * Startup selection (the pilot's second surface) is not on {@link SelectorHost}:
 * the default path is the pre-pilot pi implementation unchanged, and only the
 * termDOM host implements `selectFromList` — see `startup-ui.ts`, which branches
 * on {@link resolveTuiBackend} and lazy-imports the termDOM host when chosen.
 */
export interface ListSelectionRunOptions {
	model: import("./list-selector-model.ts").ListSelectorModel;
}

export type ListSelectionResult = { outcome: "selected"; index: number } | { outcome: "cancelled" };

export type SessionSelectionResult =
	| { outcome: "selected"; sessionPath: string }
	| { outcome: "cancelled" }
	| { outcome: "exit" };

/**
 * A host that owns a terminal for the duration of one selection.
 *
 * Attachment, input, rendering, resize, and teardown all belong to the host.
 * `dispose()` is awaited so a backend can be fully torn down — raw mode, cursor,
 * mouse reporting, bracketed paste, alternate screen — before anything else
 * attaches. Two renderers must never hold stdin at once.
 */
export interface SelectorHost {
	readonly kind: TuiBackendName;
	selectSession(options: SessionSelectorRunOptions): Promise<SessionSelectionResult>;
	dispose(): Promise<void>;
}

export interface TerminalUiBackend {
	readonly kind: TuiBackendName;
	createSelectorHost(): SelectorHost;
}

export interface ResolveTuiBackendInput {
	env?: Record<string, string | undefined>;
	/** The `tui.backend` setting, if configured. */
	setting?: unknown;
}

export interface ResolvedTuiBackend {
	backend: TuiBackendName;
	source: "env" | "setting" | "default";
	/** Set when a configured value was not a backend name and was ignored. */
	warning?: string;
}

/**
 * Resolve which backend runs: `ORPHUS_TUI_BACKEND`, then `tui.backend`, then the
 * release default.
 *
 * An unrecognized value falls through to the next source with a warning rather
 * than failing startup — a typo in a setting should not stop someone opening a
 * session picker.
 */
export function resolveTuiBackend(input: ResolveTuiBackendInput = {}): ResolvedTuiBackend {
	const envValue = (input.env ?? process.env)[ENV_TUI_BACKEND]?.trim();
	if (envValue) {
		if (isTuiBackendName(envValue)) return { backend: envValue, source: "env" };
		return {
			backend: DEFAULT_TUI_BACKEND,
			source: "default",
			warning: `Ignoring ${ENV_TUI_BACKEND}="${envValue}": expected "pi" or "termdom".`,
		};
	}
	if (input.setting !== undefined) {
		if (isTuiBackendName(input.setting)) return { backend: input.setting, source: "setting" };
		return {
			backend: DEFAULT_TUI_BACKEND,
			source: "default",
			warning: `Ignoring tui.backend="${String(input.setting)}": expected "pi" or "termdom".`,
		};
	}
	return { backend: DEFAULT_TUI_BACKEND, source: "default" };
}
