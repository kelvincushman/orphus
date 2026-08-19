/**
 * The curated speech-model catalog.
 *
 * No model ships inside Orphus. What ships is this list: for each entry, the
 * repository and the **exact revision**, the exact filename, size, and SHA-256,
 * and a link to the licence the weights are under. Everything needed to fetch a
 * specific artifact, prove it is the one intended, and read its terms before
 * agreeing to them.
 *
 * It is curated rather than exhaustive on purpose. A picker listing sixty
 * near-identical quantizations is a picker nobody can choose from; four entries
 * that actually differ — smallest, fastest English, broadest language,
 * translation-capable — is a choice.
 *
 * Sizes and hashes are transcribed from the upstream pi-transcribe catalog at
 * the revision recorded in UPSTREAM.md.
 */

export interface CatalogModel {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Hugging Face repository holding the weights. */
	readonly repository: string;
	/** Pinned commit. Never a branch: a moving reference is not a pin. */
	readonly revision: string;
	readonly filename: string;
	/** Exact byte size, checked before the hash so a truncated download fails fast. */
	readonly size: number;
	readonly sha256: string;
	readonly license: string;
	readonly licenseUrl: string;
	readonly languages: readonly string[];
	readonly recommended: boolean;
}

const LICENSE_URLS: Record<string, string> = {
	"cc-by-4.0": "https://creativecommons.org/licenses/by/4.0/",
	"apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
};

function model(entry: Omit<CatalogModel, "licenseUrl">): CatalogModel {
	const licenseUrl = LICENSE_URLS[entry.license];
	if (!licenseUrl) throw new Error(`Catalog entry ${entry.id} has no licence link for "${entry.license}"`);
	return { ...entry, licenseUrl };
}

export const CATALOG_MODELS: readonly CatalogModel[] = [
	model({
		id: "canary-180m-flash",
		name: "Canary 180M Flash",
		description: "Tiny and instant. The one to try first — it runs well on any hardware.",
		repository: "handy-computer/canary-180m-flash-gguf",
		revision: "b147f9dc52b59f0998e410540a84727bd86457fd",
		filename: "canary-180m-flash-Q8_0.gguf",
		size: 218_447_552,
		sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
		license: "cc-by-4.0",
		languages: ["en", "de", "es", "fr"],
		recommended: true,
	}),
	model({
		id: "parakeet-unified-en-0.6b",
		name: "Parakeet Unified EN 0.6B",
		description: "Fast and accurate, English only.",
		repository: "handy-computer/parakeet-unified-en-0.6b-gguf",
		revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
		filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
		size: 731_357_568,
		sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
		license: "cc-by-4.0",
		languages: ["en"],
		recommended: true,
	}),
	model({
		id: "whisper-medium",
		name: "Whisper Medium",
		description: "The broadest language coverage here, at the cost of some speed.",
		repository: "handy-computer/whisper-medium-gguf",
		revision: "ec78f06fded51aa82cde751678b78f76f78c8b7f",
		filename: "whisper-medium-Q8_0.gguf",
		size: 831_538_144,
		sha256: "09e6a65e7de377aa5b10bae24608bc6f8ca2ed04b3993ef10d4a02bcd9a82adf",
		license: "apache-2.0",
		// Whisper covers ~99 languages; the ones people configure most are listed.
		languages: ["ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "uk", "zh"],
		recommended: true,
	}),
	model({
		id: "canary-1b-v2",
		name: "Canary 1B v2",
		description: "25 European languages, with translation.",
		repository: "handy-computer/canary-1b-v2-gguf",
		revision: "58d13c2c0102229aad45f7e19a77ddc42b41dd9a",
		filename: "canary-1b-v2-Q5_K_M.gguf",
		size: 836_664_032,
		sha256: "9c3a893c93795438baf9b4b1c853c39b60316c3a0d259a3ba6e284712f5ddb71",
		license: "cc-by-4.0",
		languages: [
			"bg",
			"cs",
			"da",
			"de",
			"el",
			"en",
			"es",
			"et",
			"fi",
			"fr",
			"hr",
			"hu",
			"it",
			"lt",
			"lv",
			"mt",
			"nl",
			"pl",
			"pt",
			"ro",
			"ru",
			"sk",
			"sl",
			"sv",
			"uk",
		],
		recommended: false,
	}),
];

export function getCatalogModel(id: string): CatalogModel | undefined {
	return CATALOG_MODELS.find((entry) => entry.id === id);
}

/** Reduce a language tag to the subtag the catalog indexes by. */
export function canonicalLanguage(language: string): string {
	return language.trim().toLowerCase().split("-", 1)[0] ?? "";
}

export function modelSupportsLanguage(entry: CatalogModel, language: string): boolean {
	if (language === "auto") return true;
	return entry.languages.includes(canonicalLanguage(language));
}

/** Models that can transcribe every requested language, best-recommended first. */
export function modelsForLanguages(languages: readonly string[]): CatalogModel[] {
	return CATALOG_MODELS.filter((entry) => languages.every((language) => modelSupportsLanguage(entry, language))).sort(
		(a, b) => Number(b.recommended) - Number(a.recommended) || a.size - b.size,
	);
}

/** The URL a model's weights are fetched from, pinned to its revision. */
export function modelDownloadUrl(entry: CatalogModel): string {
	return `https://huggingface.co/${entry.repository}/resolve/${entry.revision}/${entry.filename}`;
}

export function formatSize(bytes: number): string {
	const mb = bytes / 1024 / 1024;
	if (mb < 1024) return `${Math.round(mb)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}
