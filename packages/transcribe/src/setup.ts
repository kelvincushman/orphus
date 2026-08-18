import type { ExtensionContext } from "@orphus/coding-agent";
import { type CatalogModel, formatSize, modelsForLanguages } from "./catalog.ts";
import { ensureModelDownloaded, modelPath } from "./download.ts";
import {
	DEFAULT_MICROPHONE,
	DEFAULT_SHORTCUT,
	SETTINGS_VERSION,
	type TranscribeSettings,
	writeSettings,
} from "./settings.ts";

export interface SetupPaths {
	settingsPath: string;
	modelsDir: string;
}

/**
 * The prompt shown before a model is downloaded.
 *
 * Size and licence, both, before consent. Exported because the wording is the
 * agreement — a test that asserts consent was asked should assert what was
 * asked.
 */
export function downloadPrompt(model: CatalogModel): { title: string; message: string } {
	return {
		title: `Download ${model.name}?`,
		message: [
			`${model.description}`,
			``,
			`Size:    ${formatSize(model.size)}`,
			`Licence: ${model.license} — ${model.licenseUrl}`,
			`From:    ${model.repository} @ ${model.revision.slice(0, 12)}`,
			``,
			`The download is verified against a pinned checksum before it is used.`,
		].join("\n"),
	};
}

/**
 * First-run setup: which languages, which model, then download with consent.
 *
 * Language first, because it is the question the user can answer without
 * knowing anything about the models — and answering it removes most of them
 * from the choice that follows.
 */
export async function runFirstRunSetup(
	ctx: ExtensionContext,
	paths: SetupPaths,
): Promise<TranscribeSettings | undefined> {
	const language = await ctx.ui.input("What language will you dictate in?", "en, de, ja… or 'auto'");
	if (language === undefined) return undefined;
	const normalized = language.trim() || "auto";
	const candidates = modelsForLanguages(normalized === "auto" ? [] : [normalized]);
	if (candidates.length === 0) {
		ctx.ui.notify(`No bundled model covers "${normalized}".`, "warning");
		return undefined;
	}

	const labels = candidates.map((model) => `${model.name} — ${formatSize(model.size)} (${model.license})`);
	const chosenLabel = await ctx.ui.select("Choose a speech model", labels);
	if (chosenLabel === undefined) return undefined;
	const model = candidates[labels.indexOf(chosenLabel)];
	if (!model) return undefined;

	const result = await ensureModelDownloaded({
		model,
		modelsDir: paths.modelsDir,
		consent: async () => {
			const prompt = downloadPrompt(model);
			return ctx.ui.confirm(prompt.title, prompt.message);
		},
		onProgress: ({ receivedBytes, totalBytes }) => {
			const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
			ctx.ui.setStatus("transcribe", `Downloading ${model.name}… ${percent}%`);
		},
	});
	ctx.ui.setStatus("transcribe", undefined);

	if (result.outcome === "declined") {
		ctx.ui.notify("No model downloaded, so dictation is not set up.", "info");
		return undefined;
	}
	if (result.outcome === "cancelled") return undefined;
	if (result.outcome === "failed") {
		ctx.ui.notify(`Model download failed: ${result.reason}`, "error");
		return undefined;
	}

	const settings: TranscribeSettings = {
		version: SETTINGS_VERSION,
		shortcut: DEFAULT_SHORTCUT,
		preferredLanguages: normalized === "auto" ? [] : [normalized],
		transcriptionLanguage: normalized,
		microphone: DEFAULT_MICROPHONE,
		model: { source: "catalog", id: model.id, path: modelPath(paths.modelsDir, model) },
	};
	await writeSettings(paths.settingsPath, settings);
	return settings;
}
