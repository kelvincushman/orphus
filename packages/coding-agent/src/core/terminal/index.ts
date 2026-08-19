import type { SelectorHost, TerminalUiBackend, TuiBackendName } from "./backend.ts";
import { resolveTuiBackend } from "./backend.ts";

export {
	DEFAULT_TUI_BACKEND,
	ENV_TUI_BACKEND,
	isTuiBackendName,
	type ListSelectionResult,
	type ListSelectionRunOptions,
	type ResolvedTuiBackend,
	resolveTuiBackend,
	type SelectorHost,
	type SessionSelectionResult,
	type SessionSelectorRunOptions,
	type TerminalUiBackend,
	type TuiBackendName,
} from "./backend.ts";
export { keyboardEventToData } from "./keyboard-bridge.ts";
export { type ListChoice, ListSelectorModel, type ListSelectorState } from "./list-selector-model.ts";
export {
	type NameFilter,
	type SelectorMode,
	type SessionScope,
	SessionSelectorModel,
	type SessionSelectorState,
	type SortMode,
} from "./session-selector-model.ts";
export { LIST_DETAIL_MIN_COLUMNS, renderListSelectorHtml } from "./termdom-list-view.ts";
export { DETAIL_PANEL_MIN_COLUMNS, renderSelectorHtml, type ViewportSize } from "./termdom-view.ts";

/**
 * Load a backend.
 *
 * termDOM is imported lazily so a session on the default backend never pays for
 * its module graph — CSS parsing, bidi, line breaking — at startup.
 */
export async function loadTerminalUiBackend(kind: TuiBackendName): Promise<TerminalUiBackend> {
	if (kind === "termdom") return (await import("./termdom-backend.ts")).termDomBackend;
	return (await import("./pi-backend.ts")).piBackend;
}

/**
 * Create the selector host this session should use.
 *
 * Precedence is `ORPHUS_TUI_BACKEND`, then the `tui.backend` setting, then the
 * release default. The chosen backend and any warning about an ignored value
 * come back with the host so the caller can report them.
 */
export async function createSelectorHost(input?: {
	env?: Record<string, string | undefined>;
	setting?: string;
}): Promise<{ host: SelectorHost; backend: TuiBackendName; source: string; warning?: string }> {
	const resolved = resolveTuiBackend(input);
	const backend = await loadTerminalUiBackend(resolved.backend);
	return {
		host: backend.createSelectorHost(),
		backend: resolved.backend,
		source: resolved.source,
		...(resolved.warning ? { warning: resolved.warning } : {}),
	};
}
