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
		const { dom, transport } = await this.attach();

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

			// The current scope loads at open; the cross-project scope is a full
			// session scan and loads on the first switch to it, as the interface
			// documents and the pi picker behaves.
			let allRequested = false;
			const onChange = () => {
				if (!allRequested && model.getState().scope === "all") {
					allRequested = true;
					void loadScope(run, "all", run.loadAllSessions);
				}
				render();
			};
			const unsubscribe = model.subscribe(onChange);
			document.addEventListener("keydown", onKeyDown);
			document.addEventListener("click", onClick);
			window.addEventListener("resize", render);
			render();

			void loadScope(run, "current", run.loadCurrentSessions);
		});
	}

	async selectFromList(run: ListSelectionRunOptions): Promise<ListSelectionResult> {
		const keybindings = this.options.keybindings ?? KeybindingsManager.create();
		const { dom, transport } = await this.attach();

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

	/**
	 * Attach one renderer. A selection while another is live would put two
	 * readers on stdin — the exact failure this class exists to prevent — so it
	 * is refused loudly rather than silently orphaning the first attachment.
	 */
	private async attach(): Promise<{ dom: TermDOM; transport: TerminalTransport }> {
		if (this.dom) throw new Error("A selection is already running on this host. Dispose it before starting another.");
		const transport = this.options.transport ?? transportFromProcess();
		const dom = new TermDOM({ transport });
		this.dom = dom;
		await dom.attach();
		return { dom, transport };
	}

	/** Hand the terminal back. Idempotent per attachment, and awaited by every caller. */
	dispose(): Promise<void> {
		const dom = this.dom;
		if (!dom) return this.disposing ?? Promise.resolve();
		// The latch clears once teardown completes, so a host that runs a second
		// selection can release that attachment too instead of returning the
		// first teardown's settled promise forever.
		this.disposing ??= dom.dispose().finally(() => {
			this.dom = undefined;
			this.disposing = undefined;
		});
		return this.disposing;
	}
}

/** Load one scope into the model. A failure surfaces as an error banner, not a crash. */
async function loadScope(
	run: SessionSelectorRunOptions,
	scope: "current" | "all",
	loader: SessionSelectorRunOptions["loadCurrentSessions"],
): Promise<void> {
	try {
		run.model.setSessions(scope, await loader());
	} catch (error) {
		run.model.setError(`Could not load ${scope} sessions: ${error instanceof Error ? error.message : String(error)}`);
	}
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
			if (!path || !run.deleteSession) {
				// Nothing to delete, or nothing that can: close the confirmation
				// rather than pretending.
				model.cancelDelete();
				return undefined;
			}
			model.removeSession(path);
			void run.deleteSession(path).catch(async (error) => {
				// The file is still there; a list that hides it would be lying.
				// Reload the scope from disk so the row comes back with the truth.
				await reloadScope(run, model.getState().scope);
				model.setError(`Could not delete the session: ${errorMessage(error)}`);
			});
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
				void run.renameSession(committed.path, committed.name).catch(async (error) => {
					// The rename never landed on disk; put the real names back.
					await reloadScope(run, model.getState().scope);
					model.setError(`Could not rename the session: ${errorMessage(error)}`);
				});
			}
			return undefined;
		}
		if (data === "\x7f") {
			model.setRenameDraft(dropLastCodePoint(state.renameDraft));
			return undefined;
		}
		if (isPrintableKeystroke(data)) model.setRenameDraft(state.renameDraft + data);
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
	// Offered only when the run can actually perform them: a confirmation that
	// deletes nothing, or a rename nothing persists, is a lying UI.
	if (keybindings.matches(data, "app.session.delete")) {
		if (run.deleteSession) model.requestDelete();
		return undefined;
	}
	if (keybindings.matches(data, "app.session.rename")) {
		if (run.renameSession) model.startRename();
		return undefined;
	}
	if (data === "\x7f") {
		model.setQuery(dropLastCodePoint(state.query));
		return undefined;
	}
	if (isPrintableKeystroke(data)) model.setQuery(state.query + data);
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
		model.setQuery(dropLastCodePoint(state.query));
		return undefined;
	}
	if (isPrintableKeystroke(data)) model.setQuery(state.query + data);
	return undefined;
}

/**
 * One keystroke of text: a single code point at or above U+0020. Counted in
 * code points, not UTF-16 units — the keyboard bridge deliberately lets an
 * emoji through as one keystroke, and a `length === 1` check here would throw
 * it away again.
 */
function isPrintableKeystroke(data: string): boolean {
	if ([...data].length !== 1) return false;
	const codePoint = data.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
}

/** Backspace by code point, so deleting after an emoji cannot strand a surrogate half. */
function dropLastCodePoint(text: string): string {
	return [...text].slice(0, -1).join("");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Refresh one scope from disk after a persist failure, so the list tells the truth. */
async function reloadScope(run: SessionSelectorRunOptions, scope: "current" | "all"): Promise<void> {
	await loadScope(run, scope, scope === "all" ? run.loadAllSessions : run.loadCurrentSessions);
}

export const termDomBackend: TerminalUiBackend = {
	kind: "termdom",
	createSelectorHost: () => new TermDomSelectorHost(),
};
