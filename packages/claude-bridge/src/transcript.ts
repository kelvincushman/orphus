/**
 * Translate pi's transcript-shaped provider input into the prompt/tools fields used by
 * the bridge's downstream consumers.
 *
 * System messages carry the base prompt and tool set plus later section patches and tool
 * deltas. pi-ai replays that state, but preserves section replay order. Prompt capture
 * keys come from pi's canonical section builder, so a deleted and re-added section must
 * be ranked back into canonical order before the bridge performs its exact-key lookup.
 */
import { contentText, type Context, type TextContent, type Tool } from "@earendil-works/pi-ai";

type TranscriptSystemMessage = {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: Array<{ name: string }>;
	timestamp: number;
};

function currentTools(messages: Context["messages"]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const system = message as TranscriptSystemMessage;
		for (const tool of system.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

function currentSystemMessage(messages: Context["messages"]): TranscriptSystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (message.role !== "system") continue;
		const system = message as TranscriptSystemMessage;
		timestamp ??= system.timestamp;
		const text = contentText(system.content);
		if (text) content.push(text);
		for (const [name, value] of Object.entries(system.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = currentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** pi's canonical built-in section order; custom sections follow their replay position.
 *  Known limitation, inherited from the pre-swap replay: if pi reorders existing custom
 *  sections while patching an unrelated one, the replay diverges from getSystemPrompt()
 *  and the exact-key capture lookup throws on that legitimate turn. Untriggered today:
 *  pi builds custom sections in one patch per render. */
const SECTION_RANK = new Map<string, number>([
	["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4],
	["project_context", 5], ["skills", 6], ["cwd", 7],
]);

/**
 * The map's entries, stably sorted by canonical rank. A name absent from the rank table
 * inherits its replayed predecessor's rank, so an already-canonical replay remains
 * unchanged and custom sections retain their position.
 */
function stableRanked(sections: Map<string, string>, ranks: Map<string, number>): Map<string, string> {
	let predecessorRank = -1;
	const ranked = [...sections].map(([name, value]) => {
		const rank = ranks.get(name) ?? predecessorRank;
		predecessorRank = rank;
		return { name, value, rank };
	});
	ranked.sort((a, b) => a.rank - b.rank);
	return new Map(ranked.map(({ name, value }) => [name, value]));
}

/** Render replayed system state in the same section order as pi's prompt builder. */
function canonicalSystemPrompt(message: TranscriptSystemMessage | undefined): string | undefined {
	if (!message) return undefined;
	const sections = new Map<string, string>(
		Object.entries(message.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	const parts = [contentText(message.content), ...stableRanked(sections, SECTION_RANK).values()]
		.filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Restore the prompt and tools fields expected by the bridge and remove prompt-state
 * messages from conversation history. Contexts without system messages are returned
 * unchanged because systemless one-off calls already use the bridge-compatible shape.
 */
export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const tools = currentTools(context.messages);
	return {
		...context,
		systemPrompt: canonicalSystemPrompt(currentSystemMessage(context.messages)),
		tools: tools.length > 0 ? tools : undefined,
		messages: nonSystemMessages(context.messages),
	};
}

/** `messages` with every prompt-state system message removed from conversation history. */
export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
