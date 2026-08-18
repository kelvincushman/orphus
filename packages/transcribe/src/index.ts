import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@orphus/coding-agent";
import { getAgentDir } from "@orphus/coding-agent";
import { createTranscriptionBackend, type TranscriptionBackend } from "./backend.ts";
import { openHelperChannel, openWorkerChannel } from "./channels.ts";
import { TranscribeController, type TranscribeUi } from "./controller.ts";
import { DEFAULT_SHORTCUT, readSettings, type TranscribeSettings } from "./settings.ts";
import { runFirstRunSetup } from "./setup.ts";

export { createTranscriptionBackend, ProtocolBackend, type TranscriptionBackend } from "./backend.ts";
export { CATALOG_MODELS, type CatalogModel } from "./catalog.ts";
export { TranscribeController, type TranscribeUi } from "./controller.ts";
export { ensureModelDownloaded } from "./download.ts";
export { createFakeChannel } from "./fake-channel.ts";
export * from "./protocol.ts";
export { DEFAULT_SHORTCUT, readSettings, type TranscribeSettings, writeSettings } from "./settings.ts";

/** Where settings and downloaded models live, under the agent directory. */
export function transcribePaths(agentDir: string = getAgentDir()): {
	settingsPath: string;
	modelsDir: string;
	nativeDir: string;
} {
	return {
		settingsPath: join(agentDir, "transcribe.json"),
		modelsDir: join(agentDir, "transcribe-models"),
		nativeDir: new URL("../native", import.meta.url).pathname,
	};
}

function createUi(ctx: ExtensionContext): TranscribeUi {
	return {
		// `pasteToEditor` inserts and leaves the draft for the user to read. It
		// never submits, which is the whole contract of dictation here.
		insertText: (text) => ctx.ui.pasteToEditor(text),
		notify: (message, level) => ctx.ui.notify(message, level),
		setStatus: (text) => ctx.ui.setStatus("transcribe", text),
	};
}

/**
 * Local dictation.
 *
 * `/transcribe` and the shortcut are the same action; both toggle recording.
 * The transcript is pasted into the editor and nothing else happens — reading
 * it before sending is the user's job and the user's decision.
 */
export default function transcribeExtension(pi: ExtensionAPI): void {
	let controller: TranscribeController | undefined;
	let stopListening: (() => void) | undefined;
	let settings: TranscribeSettings | undefined;
	const paths = transcribePaths();

	const resolveBackend = async (ctx: ExtensionContext): Promise<TranscriptionBackend | undefined> => {
		if (!settings) {
			const stored = await readSettings(paths.settingsPath);
			// A rejected existing file — corrupt, or a future version — must be
			// said out loud before setup runs again, or the user watches their
			// configuration silently vanish.
			if (stored.warning) ctx.ui.notify(stored.warning, "warning");
			settings = stored.settings;
		}
		if (!settings) {
			settings = await runFirstRunSetup(ctx, paths);
			if (!settings) return undefined;
		}
		const selection = await createTranscriptionBackend({
			initialize: { modelPath: settings.model.path, language: settings.transcriptionLanguage, sampleRate: 16_000 },
			openWorker: () => openWorkerChannel({ nativeDir: paths.nativeDir }),
			openHelper: () => openHelperChannel({ nativeDir: paths.nativeDir }),
		});
		// Say when the primary runtime did not come up. A session quietly running
		// on the fallback is a session nobody can debug later.
		const workerAttempt = selection.attempts.find((attempt) => attempt.kind === "worker");
		if (selection.backend.kind === "helper" && workerAttempt?.reason) {
			ctx.ui.notify(`Transcribing through the helper: ${workerAttempt.reason}`, "warning");
		}
		return selection.backend;
	};

	/**
	 * Escape cancels — but only while dictation is running.
	 *
	 * A raw input listener rather than a registered shortcut, because a shortcut
	 * cannot decline a key: registering Escape globally would take it away from
	 * everything else in the session. The listener consumes Escape exactly when
	 * the controller had something to cancel, and passes it through otherwise.
	 */
	function listenForEscape(ctx: ExtensionContext): void {
		if (stopListening || !ctx.hasUI) return;
		stopListening = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x1b") return undefined;
			const active = controller?.state !== "idle";
			if (!active) return undefined;
			void controller?.cancel();
			return { consume: true };
		});
	}

	const controllerFor = (ctx: ExtensionContext): TranscribeController => {
		controller ??= new TranscribeController({
			ui: createUi(ctx),
			resolveBackend: () => resolveBackend(ctx),
			device: () => (settings?.microphone.type === "device" ? settings.microphone.name : undefined),
		});
		return controller;
	};

	pi.registerCommand("transcribe", {
		description: "Dictate into the editor with a local speech model",
		handler: async (_args, ctx) => {
			listenForEscape(ctx);
			await controllerFor(ctx).toggle();
		},
	});

	// The cast is load-bearing: pi-tui's `KeyId` union does not name ctrl+alt
	// chords, but the runtime keybinding parser accepts them.
	pi.registerShortcut(DEFAULT_SHORTCUT as never, {
		description: "Start or stop dictation",
		handler: async (ctx) => {
			listenForEscape(ctx);
			await controllerFor(ctx).toggle();
		},
	});

	pi.on("session_shutdown", async () => {
		stopListening?.();
		stopListening = undefined;
		await controller?.dispose();
		controller = undefined;
	});
}
