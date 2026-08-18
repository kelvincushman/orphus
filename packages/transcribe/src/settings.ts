import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Transcription settings.
 *
 * Written atomically at `0600`: a temporary file in the same directory, then a
 * rename. A half-written settings file is a first run the user did not ask for,
 * and the file records which microphone is in use — owner-only is the right
 * default for that whether or not it is strictly a secret.
 */

export const SETTINGS_VERSION = 1;

export type MicrophoneSetting = { type: "system-default" } | { type: "device"; name: string; occurrence: number };

export const DEFAULT_MICROPHONE: MicrophoneSetting = { type: "system-default" };

/** Ctrl+Alt+Z by default, matching the surface this package inherited. */
export const DEFAULT_SHORTCUT = "ctrl+alt+z";

export interface TranscribeSettings {
	version: typeof SETTINGS_VERSION;
	shortcut: string;
	/** Languages the user expects to speak, used to narrow the model picker. */
	preferredLanguages: string[];
	/** A language code, or "auto" to let a capable model detect it. */
	transcriptionLanguage: string;
	microphone: MicrophoneSetting;
	model: { source: "catalog"; id: string; path: string };
}

export interface SettingsReadResult {
	settings?: TranscribeSettings;
	/** Set when a file existed but could not be used, so the caller can say so. */
	warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMicrophone(value: unknown): MicrophoneSetting {
	if (!isRecord(value)) return DEFAULT_MICROPHONE;
	if (value.type === "device" && typeof value.name === "string") {
		return {
			type: "device",
			name: value.name,
			occurrence: typeof value.occurrence === "number" ? value.occurrence : 0,
		};
	}
	return DEFAULT_MICROPHONE;
}

/**
 * Parse settings, or explain why not.
 *
 * A malformed or future-versioned file is reported rather than repaired: this
 * package would otherwise silently discard a configuration a newer build wrote,
 * and the user would find their settings gone with no explanation.
 */
export function parseSettings(raw: string): SettingsReadResult {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { warning: "Transcription settings could not be parsed; running first-run setup instead." };
	}
	if (!isRecord(value)) return { warning: "Transcription settings are not an object." };
	if (value.version !== SETTINGS_VERSION) {
		return {
			warning: `Transcription settings are version ${String(value.version)}; this build reads ${SETTINGS_VERSION}.`,
		};
	}
	const model = value.model;
	if (!isRecord(model) || typeof model.id !== "string" || typeof model.path !== "string") {
		return { warning: "Transcription settings name no model." };
	}
	return {
		settings: {
			version: SETTINGS_VERSION,
			shortcut: typeof value.shortcut === "string" ? value.shortcut : DEFAULT_SHORTCUT,
			preferredLanguages: Array.isArray(value.preferredLanguages)
				? value.preferredLanguages.filter((entry): entry is string => typeof entry === "string")
				: [],
			transcriptionLanguage: typeof value.transcriptionLanguage === "string" ? value.transcriptionLanguage : "auto",
			microphone: parseMicrophone(value.microphone),
			model: { source: "catalog", id: model.id, path: model.path },
		},
	};
}

export async function readSettings(path: string): Promise<SettingsReadResult> {
	try {
		return parseSettings(await readFile(path, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") return {};
		return { warning: `Transcription settings could not be read: ${error instanceof Error ? error.message : error}` };
	}
}

/**
 * Write settings atomically, owner-only.
 *
 * The temporary file is created in the destination directory so the rename is
 * within one filesystem and therefore atomic, and its mode is set before the
 * rename so the file is never briefly world-readable at its final path.
 */
export async function writeSettings(path: string, settings: TranscribeSettings): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}
