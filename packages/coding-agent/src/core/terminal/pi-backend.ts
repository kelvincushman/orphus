import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import { SessionSelectorComponent } from "../../modes/interactive/components/session-selector.ts";
import { KeybindingsManager } from "../keybindings.ts";
import type {
	SelectorHost,
	SessionSelectionResult,
	SessionSelectorRunOptions,
	TerminalUiBackend,
	TuiBackendName,
} from "./backend.ts";

/**
 * The pi session picker: the existing renderer, behind the backend interface.
 *
 * This is deliberately a thin adapter rather than a rewrite. Pi remains the
 * default and the fallback for the whole pilot, so its behaviour must not move
 * while termDOM is being built beside it — the shared model exists to pull the
 * *logic* out, not to change what pi does with it.
 */
export class PiSelectorHost implements SelectorHost {
	readonly kind: TuiBackendName = "pi";
	private ui: TUI | undefined;
	private selector: SessionSelectorComponent | undefined;
	private disposing: Promise<void> | undefined;

	selectSession(run: SessionSelectorRunOptions): Promise<SessionSelectionResult> {
		return new Promise<SessionSelectionResult>((resolve) => {
			const ui = new TUI(new ProcessTerminal(), undefined, getAgentDir());
			const keybindings = KeybindingsManager.create();
			setKeybindings(keybindings);
			this.ui = ui;
			let settled = false;
			const finish = (result: SessionSelectionResult) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};

			const selector = new SessionSelectorComponent(
				run.loadCurrentSessions,
				run.loadAllSessions,
				(sessionPath: string) => finish({ outcome: "selected", sessionPath }),
				() => finish({ outcome: "cancelled" }),
				() => finish({ outcome: "exit" }),
				() => ui.requestRender(),
				{
					showRenameHint: run.renameSession !== undefined,
					keybindings,
					...(run.renameSession
						? {
								renameSession: async (path: string, name: string | undefined) =>
									run.renameSession?.(path, name ?? ""),
							}
						: {}),
				},
			);
			this.selector = selector;

			ui.addChild(selector);
			ui.setFocus(selector.getSessionList());
			ui.start();
		});
	}

	/** Stop the TUI and release the terminal. Idempotent per attachment. */
	dispose(): Promise<void> {
		this.disposing ??= (async () => {
			this.selector?.dispose();
			this.ui?.stop();
			this.selector = undefined;
			this.ui = undefined;
		})().finally(() => {
			// Cleared so a later selection's TUI is stopped rather than skipped.
			this.disposing = undefined;
		});
		return this.disposing;
	}
}

export const piBackend: TerminalUiBackend = {
	kind: "pi",
	createSelectorHost: () => new PiSelectorHost(),
};
