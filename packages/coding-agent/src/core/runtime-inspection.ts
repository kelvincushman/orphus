import { createHash } from "node:crypto";
import type { HarnessCapabilities } from "./capabilities/index.ts";
import { redactCredentialFields } from "./provider-audit.ts";

/** Bump when the shape of the report changes incompatibly. */
export const RUNTIME_INSPECTION_VERSION = "orphus.inspect.runtime.v1";

export interface InspectedModel {
	provider: string;
	id: string;
	api: string;
	name?: string;
	thinkingLevel?: string;
}

export interface InspectedTool {
	name: string;
	active: boolean;
	source: string;
	/** SHA-256 of the tool's canonicalized parameter schema. */
	schemaSha256: string;
}

export interface InspectedExtension {
	path: string;
	source: string;
	/** Events this extension handles, with how many handlers it registered for each. */
	events: { event: string; handlers: number }[];
}

export interface InspectedHookOrder {
	event: string;
	/** Extension paths in the order their handlers run. */
	order: string[];
}

export interface InspectedFlag {
	name: string;
	owner?: string;
	origin?: string;
	value?: boolean | string;
	/** True when the value came from the command line rather than a registration default. */
	explicit: boolean;
}

export interface InspectedSetting {
	key: string;
	/** Which scope supplied the effective value. */
	scope: "project" | "global";
	value: unknown;
}

export interface InspectedPromptSection {
	heading: string;
	sha256: string;
	byteLength: number;
}

export interface RuntimeInspection {
	version: string;
	appVersion: string;
	model: InspectedModel | null;
	capabilities: Record<string, string>;
	tools: InspectedTool[];
	extensions: InspectedExtension[];
	hookOrder: InspectedHookOrder[];
	flags: InspectedFlag[];
	settings: InspectedSetting[];
	systemPrompt: {
		sha256: string;
		byteLength: number;
		sections: InspectedPromptSection[];
		/** Present only with `--include-content`. */
		content?: string;
	};
}

export interface RuntimeInspectionInput {
	appVersion: string;
	model?: InspectedModel;
	capabilities: HarnessCapabilities;
	tools: { name: string; parameters: unknown; source: string; active: boolean }[];
	extensions: { path: string; source: string; handlers: Map<string, unknown[]> }[];
	flags: { name: string; owner?: string; origin?: string; value?: boolean | string; explicit: boolean }[];
	globalSettings: Record<string, unknown>;
	projectSettings: Record<string, unknown>;
	systemPrompt: string;
	includeContent?: boolean;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Redact a single named value by running it through the shared credential
 * sweep under its own key, so `apiKey: "sk-…"` is caught whether it arrives as
 * a flag, a setting, or a nested settings object.
 */
function redactValue(key: string, value: unknown): unknown {
	const { value: redacted } = redactCredentialFields({ [key]: value });
	return (redacted as Record<string, unknown>)[key];
}

/**
 * Serialize with keys in sorted order so a schema hash depends on the schema,
 * not on the order a provider happened to build the object in.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Split a resolved system prompt into its top-level `# ` sections. Everything
 * before the first heading is reported as `preamble`, which is where the bulk
 * of the default prompt lives.
 */
export function splitPromptSections(prompt: string): { heading: string; body: string }[] {
	const sections: { heading: string; body: string }[] = [];
	let heading = "preamble";
	let body: string[] = [];
	for (const line of prompt.split("\n")) {
		if (line.startsWith("# ")) {
			sections.push({ heading, body: body.join("\n") });
			heading = line.slice(2).trim();
			body = [];
			continue;
		}
		body.push(line);
	}
	sections.push({ heading, body: body.join("\n") });
	return sections.filter((section, index) => index > 0 || section.body.trim().length > 0);
}

/**
 * Build the deterministic runtime report.
 *
 * Everything is sorted, so two runs of the same configuration produce
 * byte-identical output and a diff between two runs is a real difference.
 * Settings and flag values pass through the same credential redaction the
 * provider records use, in both modes — `--include-content` widens what is
 * reported about the system prompt, never what is reported about secrets.
 */
export function buildRuntimeInspection(input: RuntimeInspectionInput): RuntimeInspection {
	const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

	const effectiveSettings: InspectedSetting[] = [];
	const settingKeys = new Set([...Object.keys(input.globalSettings), ...Object.keys(input.projectSettings)]);
	for (const key of [...settingKeys].sort()) {
		const fromProject = Object.hasOwn(input.projectSettings, key);
		const raw = fromProject ? input.projectSettings[key] : input.globalSettings[key];
		effectiveSettings.push({ key, scope: fromProject ? "project" : "global", value: redactValue(key, raw) });
	}

	const hookEvents = new Set<string>();
	for (const extension of input.extensions) for (const event of extension.handlers.keys()) hookEvents.add(event);

	const sections = splitPromptSections(input.systemPrompt);

	return {
		version: RUNTIME_INSPECTION_VERSION,
		appVersion: input.appVersion,
		model: input.model ?? null,
		capabilities: Object.fromEntries(
			Object.entries(input.capabilities)
				.map(([name, capability]) => [name, capability.kind])
				.sort(([a], [b]) => (a < b ? -1 : 1)),
		),
		tools: input.tools
			.map((tool) => ({
				name: tool.name,
				active: tool.active,
				source: tool.source,
				schemaSha256: sha256(canonicalJson(tool.parameters)),
			}))
			.sort(byName),
		extensions: input.extensions
			.map((extension) => ({
				path: extension.path,
				source: extension.source,
				events: [...extension.handlers.entries()]
					.map(([event, handlers]) => ({ event, handlers: handlers.length }))
					.sort((a, b) => (a.event < b.event ? -1 : 1)),
			}))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		// Handler order is load order, not alphabetical: it is the order the
		// handlers actually run in, which is the thing worth reporting.
		hookOrder: [...hookEvents].sort().map((event) => ({
			event,
			order: input.extensions
				.filter((extension) => extension.handlers.has(event))
				.map((extension) => extension.path),
		})),
		flags: input.flags
			.map((flag) => ({ ...flag, value: redactValue(flag.name, flag.value) as boolean | string | undefined }))
			.sort(byName),
		settings: effectiveSettings,
		systemPrompt: {
			sha256: sha256(input.systemPrompt),
			byteLength: Buffer.byteLength(input.systemPrompt, "utf8"),
			sections: sections.map((section) => ({
				heading: section.heading,
				sha256: sha256(section.body),
				byteLength: Buffer.byteLength(section.body, "utf8"),
			})),
			...(input.includeContent ? { content: input.systemPrompt } : {}),
		},
	};
}

/** Stable two-space JSON, newline-terminated. */
export function formatRuntimeInspection(report: RuntimeInspection): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}
