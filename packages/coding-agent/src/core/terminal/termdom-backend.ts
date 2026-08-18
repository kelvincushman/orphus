import { TermDOM, type TerminalTransport, transportFromProcess } from "@b9g/termdom";
import { KeybindingsManager } from "../keybindings.ts";
import type {
	ListSelectionResult,
	ListSelectionRunOptions,
	SelectorHost,
	SessionSelectionResult,
	SessionSelectorRunOptions,
	TerminalUiBackend,
	TuiBackendName,
} from "./backend.ts";
import { type KeyboardEventLike, keyboardEventToData } from "./keyboard-bridge.ts";
import type { ListSelectorModel } from "./list-selector-model.ts";
import { renderListSelectorHtml } from "./termdom-list-view.ts";
import { renderSelectorHtml } from "./termdom-view.ts";

export interface TermDomSelectorHostOptions {
	/** Injected for headless tests. Defaults to the real process terminal. */
	transport?: TerminalTransport;
	keybindings?: KeybindingsManager;
}

/**
 * The termDOM session picker.
 *
 * termDOM owns the terminal for the whole attachment — raw mode, alternate
 * screen, mouse reporting, bracketed paste — and hands it back on `dispose()`,
 * which is awaited. Nothing else may attach until that resolves: two renderers
 * holding stdin at once is the failure mode this abstraction exists to prevent.
 */
export class TermDomSelectorHost implements SelectorHost {
	readonly kind: TuiBackendName = "termdom";
	private readonly options: TermDomSelectorHostOptions;
	private dom: TermDOM | undefined;
	private disposing: Promise<void> | undefined;

	constructor(options: TermDomSelectorHostOptions = {}) {
		this.options = options;
	}

	async selectSession(run: SessionSelectorRunOptions): Promise<SessionSelectionResult> {
		const keybindings = this.options.keybindings ?? KeybindingsManager.create();
		const transport = this.options.transport ?? transportFromProcess();
		const dom = new TermDOM({ transport });
		this.dom = dom;
		await dom.attach();

		const { document, window } = dom;
		const model = run.model;
		const render = () => {
			document.body.innerHTML = renderSelectorHtml(
				model.getState(),
				{ columns: transport.cols, rows: transport.rows },
				{ isCurrentSession: (path) => model.isCurrentSession(path) },
			);
		};

		return new Promise<SessionSelectionResult>((resolve) => {
			let settled = false;
			const finish = (result: SessionSelectionResult) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				document.removeEventListener("keydown", onKeyDown);
				document.removeEventListener("click", onClick);
				window.removeEventListener("resize", render);
				resolve(result);
			};

			const onKeyDown = (event: Event) => {
				const data = keyboardEventToData(event as unknown as KeyboardEventLike);
				if (data === undefined) return;
				const outcome = applyKey(data, keybindings, run);
				if (outcome) finish(outcome);
			};

			// Mouse row selection: every row carries its index, so a click is a
			// selection rather than a coordinate calculation.
			const onClick = (event: Event) => {
				const target = event.target as { getAttribute?: (name: string) => string | null } | null;
				const index = Number(target?.getAttribute?.("data-index") ?? Number.NaN);
				if (Number.isInteger(index)) model.select(index);
			};

			const unsubscribe = model.subscribe(render);
			document.addEventListener("keydown", onKeyDown);
			document.addEventListener("click", onClick);
			window.addEventListener("resize", render);
			render();

			void loadScopes(run);
		});
	}

	async selectFromList(run: ListSelectionRunOptions): Promise<ListSelectionResult> {
		const keybindings = this.options.keybindings ?? KeybindingsManager.create();
		const transport = this.options.transport ?? transportFromProcess();
		const dom = new TermDOM({ transport });
		this.dom = dom;
		await dom.attach();

		const { document, window } = dom;
		const model = run.model;
		const render = () => {
			document.body.innerHTML = renderListSelectorHtml(model.getState(), {
				columns: transport.cols,
				rows: transport.rows,
			});
		};

		return new Promise<ListSelectionResult>((resolve) => {
			let settled = false;
			const finish = (result: ListSelectionResult) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				document.removeEventListener("keydown", onKeyDown);
				document.removeEventListener("click", onClick);
				window.removeEventListener("resize", render);
				resolve(result);
			};
			const onKeyDown = (event: Event) => {
				const data = keyboardEventToData(event as unknown as KeyboardEventLike);
				if (data === undefined) return;
				const outcome = applyListKey(data, keybindings, model);
				if (outcome) finish(outcome);
			};
			const onClick = (event: Event) => {
				const target = event.target as { getAttribute?: (name: string) => string | null } | null;
				const index = Number(target?.getAttribute?.("data-index") ?? Number.NaN);
				if (Number.isInteger(index)) model.select(index);
			};
			const unsubscribe = model.subscribe(render);
			document.addEventListener("keydown", onKeyDown);
			document.addEventListener("click", onClick);
			window.addEventListener("resize", render);
			render();
		});
	}

	/** Hand the terminal back. Idempotent, and awaited by every caller. */
	dispose(): Promise<void> {
		const dom = this.dom;
		if (!dom) return Promise.resolve();
		this.disposing ??= dom.dispose().finally(() => {
			this.dom = undefined;
		});
		return this.disposing;
	}
}

/** Load both scopes into the model. Failures surface as an error banner, not a crash. */
async function loadScopes(run: SessionSelectorRunOptions): Promise<void> {
	const load = async (scope: "current" | "all", loader: SessionSelectorRunOptions["loadCurrentSessions"]) => {
		try {
			run.model.setSessions(scope, await loader());
		} catch (error) {
			run.model.setError(
				`Could not load ${scope} sessions: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	await Promise.all([load("current", run.loadCurrentSessions), load("all", run.loadAllSessions)]);
}

/**
 * Apply one key press. Returns a result when the key ends the selection.
 *
 * Every branch is decided by {@link KeybindingsManager}, the same configuration
 * the pi backend consults, so a rebound key rebinds both.
 */
export function applyKey(
	data: string,
	keybindings: KeybindingsManager,
	run: SessionSelectorRunOptions,
): SessionSelectionResult | undefined {
	const model = run.model;
	const state = model.getState();

	if (state.mode === "confirm-delete") {
		if (keybindings.matches(data, "tui.select.confirm")) {
			const path = state.confirmingDeletePath;
			model.removeSession(path ?? "");
			if (path && run.deleteSession) void run.deleteSession(path).catch((error) => model.setError(String(error)));
			return undefined;
		}
		if (keybindings.matches(data, "tui.select.cancel")) model.cancelDelete();
		return undefined;
	}

	if (state.mode === "rename") {
		if (keybindings.matches(data, "tui.select.cancel")) {
			model.cancelRename();
			return undefined;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			const committed = model.commitRename();
			if (committed && run.renameSession) {
				void run.renameSession(committed.path, committed.name).catch((error) => model.setError(String(error)));
			}
			return undefined;
		}
		if (data === "\x7f") {
			model.setRenameDraft(state.renameDraft.slice(0, -1));
			return undefined;
		}
		if (data.length === 1 && data >= " ") model.setRenameDraft(state.renameDraft + data);
		return undefined;
	}

	if (keybindings.matches(data, "tui.select.confirm")) {
		const selected = model.selected;
		return selected ? { outcome: "selected", sessionPath: selected.path } : undefined;
	}
	if (keybindings.matches(data, "tui.select.cancel")) return { outcome: "cancelled" };
	if (keybindings.matches(data, "tui.select.up")) {
		model.move(-1);
		return undefined;
	}
	if (keybindings.matches(data, "tui.select.down")) {
		model.move(1);
		return undefined;
	}
	if (keybindings.matches(data, "tui.input.tab")) {
		model.toggleScope();
		return undefined;
	}
	if (keybindings.matches(data, "app.session.toggleSort")) {
		model.cycleSortMode();
		return undefined;
	}
	if (keybindings.matches(data, "app.session.toggleNamedFilter")) {
		model.toggleNameFilter();
		return undefined;
	}
	if (keybindings.matches(data, "app.session.togglePath")) {
		model.togglePath();
		return undefined;
	}
	if (keybindings.matches(data, "app.session.delete")) {
		model.requestDelete();
		return undefined;
	}
	if (keybindings.matches(data, "app.session.rename")) {
		model.startRename();
		return undefined;
	}
	if (data === "\x7f") {
		model.setQuery(state.query.slice(0, -1));
		return undefined;
	}
	if (data.length === 1 && data >= " ") model.setQuery(state.query + data);
	return undefined;
}

/** One key press against a startup list. Same keybinding configuration as everywhere else. */
export function applyListKey(
	data: string,
	keybindings: KeybindingsManager,
	model: ListSelectorModel,
): ListSelectionResult | undefined {
	if (keybindings.matches(data, "tui.select.confirm")) {
		const index = model.selectedOriginalIndex;
		return index === undefined ? undefined : { outcome: "selected", index };
	}
	if (keybindings.matches(data, "tui.select.cancel")) return { outcome: "cancelled" };
	if (keybindings.matches(data, "tui.select.up")) {
		model.move(-1);
		return undefined;
	}
	if (keybindings.matches(data, "tui.select.down")) {
		model.move(1);
		return undefined;
	}
	const state = model.getState();
	if (data === "\x7f") {
		model.setQuery(state.query.slice(0, -1));
		return undefined;
	}
	if (data.length === 1 && data >= " ") model.setQuery(state.query + data);
	return undefined;
}

export const termDomBackend: TerminalUiBackend = {
	kind: "termdom",
	createSelectorHost: () => new TermDomSelectorHost(),
};
