import type { TranscriptionBackend } from "./backend.ts";

/**
 * What the controller needs from a host to run dictation.
 *
 * `insertText` puts the transcript into the editor and stops there. There is
 * deliberately no `submit`: dictation produces a draft, and a draft the user has
 * not read is not a message they meant to send. Mishearing "delete the branch"
 * and sending it is the failure this interface is shaped to prevent.
 */
export interface TranscribeUi {
	insertText(text: string): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** Status line while recording or transcribing. `undefined` clears it. */
	setStatus(text: string | undefined): void;
	/** Input level for the meter, 0..1. */
	setLevel?(level: number): void;
}

export type TranscribeState = "idle" | "recording" | "transcribing";

export interface TranscribeControllerOptions {
	ui: TranscribeUi;
	/** Resolve the backend, running first-run setup if needed. Undefined means setup was declined. */
	resolveBackend: () => Promise<TranscriptionBackend | undefined>;
	/** Capture device name, or undefined for the system default. */
	device?: () => string | undefined;
}

/**
 * The dictation state machine, with no renderer and no audio in it.
 *
 * One entry point drives everything: `/transcribe` and the keyboard shortcut
 * both call {@link toggle}, so the two surfaces cannot drift apart. Escape calls
 * {@link cancel}, which is honoured in both the recording and transcribing
 * states — a cancel that only worked before the expensive part would be the one
 * that never gets used.
 */
export class TranscribeController {
	private readonly options: TranscribeControllerOptions;
	private backend: TranscriptionBackend | undefined;
	private current: TranscribeState = "idle";
	private unsubscribeLevel: (() => void) | undefined;
	/** Set when a cancel arrives; checked before a transcript is inserted. */
	private cancelled = false;
	/**
	 * Set while `start` is awaiting the backend. The state is still `idle` for
	 * the whole of `resolveBackend` — which can be first-run setup and a model
	 * download — and a second toggle in that window must not start again.
	 */
	private starting = false;

	constructor(options: TranscribeControllerOptions) {
		this.options = options;
	}

	get state(): TranscribeState {
		return this.current;
	}

	/** Start recording when idle; stop and transcribe when recording. */
	async toggle(): Promise<void> {
		if (this.starting) return;
		if (this.current === "transcribing") {
			this.options.ui.notify("Still transcribing the previous recording.", "info");
			return;
		}
		if (this.current === "recording") return this.stopAndInsert();
		return this.start();
	}

	private async start(): Promise<void> {
		this.starting = true;
		try {
			const backend = this.backend ?? (await this.options.resolveBackend());
			if (!backend) return;
			this.backend = backend;
			this.cancelled = false;
			try {
				await backend.startRecording(this.options.device?.());
			} catch (error) {
				this.options.ui.setStatus(undefined);
				this.options.ui.notify(`Could not start recording: ${describe(error)}`, "error");
				return;
			}
			this.current = "recording";
			this.options.ui.setStatus("Recording… press the shortcut again to transcribe, Esc to cancel");
			this.unsubscribeLevel = backend.onLevel((level) => this.options.ui.setLevel?.(level));
		} finally {
			this.starting = false;
		}
	}

	private async stopAndInsert(): Promise<void> {
		const backend = this.backend;
		if (!backend) return;
		this.current = "transcribing";
		this.stopMeter();
		this.options.ui.setStatus("Transcribing… Esc to cancel");
		try {
			const transcript = await backend.stopAndTranscribe();
			if (this.cancelled) return;
			const text = transcript.text.trim();
			if (!text) {
				this.options.ui.notify("Nothing was transcribed.", "info");
				return;
			}
			// The whole point: into the editor, and no further.
			this.options.ui.insertText(text);
		} catch (error) {
			if (!this.cancelled) this.options.ui.notify(`Transcription failed: ${describe(error)}`, "error");
		} finally {
			this.current = "idle";
			this.options.ui.setStatus(undefined);
		}
	}

	/**
	 * Escape.
	 *
	 * Returns whether there was anything to cancel, so a host can let the key
	 * through to whatever else wanted it when dictation was idle.
	 */
	async cancel(): Promise<boolean> {
		if (this.current === "idle") return false;
		this.cancelled = true;
		this.stopMeter();
		const backend = this.backend;
		this.current = "idle";
		this.options.ui.setStatus(undefined);
		try {
			await backend?.cancel();
		} catch (error) {
			this.options.ui.notify(`Could not cancel cleanly: ${describe(error)}`, "warning");
		}
		this.options.ui.notify("Dictation cancelled.", "info");
		return true;
	}

	/** Release the backend. Safe to call more than once. */
	async dispose(): Promise<void> {
		this.stopMeter();
		const backend = this.backend;
		this.backend = undefined;
		this.current = "idle";
		await backend?.dispose().catch(() => undefined);
	}

	private stopMeter(): void {
		this.unsubscribeLevel?.();
		this.unsubscribeLevel = undefined;
		this.options.ui.setLevel?.(0);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
