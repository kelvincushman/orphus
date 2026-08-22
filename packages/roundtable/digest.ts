import {
	boundedRender,
	capText,
	DEFAULT_BUDGET,
	DEFAULT_HEADLINE_CAP,
	DEFAULT_PER_ITEM_CAP,
} from "./bounded-render.ts";
import type { RoomMessage } from "./types.ts";

/**
 * Token-budget protection for inter-agent chat.
 *
 * A digest is the ONLY way room content enters an agent's context window.
 * It renders unread messages newest-first into three tiers until the character
 * budget is spent:
 *
 *   1. verbatim   — full body (capped per message)
 *   2. headline   — one line: author + first fragment of the body
 *   3. collapsed  — a single count line for everything older
 *
 * The result is rendered oldest→newest so the agent reads chronologically,
 * but budget is always spent on the NEWEST messages first.
 *
 * The tiering itself lives in `bounded-render.ts`, shared with the other
 * boundaries that need the same guarantee. What stays here is what is actually
 * room-specific: the sort by seq, the clock-and-author line shape, and a
 * collapse marker that tells the reader to fetch by seq.
 */
export interface DigestOptions {
	/** Total character budget for the rendered digest body. Default 2000. */
	budget?: number;
	/** Per-message cap for verbatim bodies. Default 600. */
	perMessageCap?: number;
	/** Cap for headline fragments. Default 100. */
	headlineCap?: number;
}

export interface Digest {
	/** Rendered digest body, guaranteed ≤ budget + one overflow marker line. */
	text: string;
	/** Highest seq consumed; pass to set_cursor to mark read. 0 when no messages. */
	consumedSeq: number;
	total: number;
	verbatim: number;
	headlines: number;
	collapsed: number;
	chars: number;
}

export { DEFAULT_BUDGET, DEFAULT_HEADLINE_CAP, DEFAULT_PER_ITEM_CAP as DEFAULT_PER_MESSAGE_CAP };

function clock(timestamp: number): string {
	const d = new Date(timestamp);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/**
 * Build a bounded digest from unread messages (ascending seq order expected).
 * Deterministic and model-free: the bound holds no matter what peers post.
 */
export function buildDigest(messages: readonly RoomMessage[], options: DigestOptions = {}): Digest {
	if (messages.length === 0) {
		return { text: "No new messages.", consumedSeq: 0, total: 0, verbatim: 0, headlines: 0, collapsed: 0, chars: 0 };
	}

	const newestFirst = [...messages].sort((a, b) => b.seq - a.seq);
	const consumedSeq = newestFirst[0]?.seq ?? 0;

	const rendered = boundedRender(newestFirst, {
		budget: options.budget,
		perItemCap: options.perMessageCap,
		headlineCap: options.headlineCap,
		format: {
			text: (message) => message.text,
			verbatim: (message, cappedText, truncated) => {
				const marker = truncated > 0 ? ` …(+${truncated} chars)` : "";
				const reply = message.replyTo ? ` (reply to ${message.replyTo})` : "";
				return `[${clock(message.timestamp)}] ${message.from.name}#${message.seq}${reply}: ${cappedText}${marker}`;
			},
			headline: (message, cappedFirstLine, hasMore) =>
				`· ${message.from.name}#${message.seq}: ${cappedFirstLine}${hasMore ? " …" : ""}`,
			// The digest advances the read cursor past everything it consumed,
			// collapsed included — so "raise budget and re-digest" is a dead end
			// (the next digest starts after these). Advise the one recovery that
			// works: fetch names the exact seq range the collapse swallowed.
			collapsed: (count) => {
				const oldest = newestFirst[newestFirst.length - 1]?.seq ?? 1;
				return `(${count} older message${count === 1 ? "" : "s"} collapsed — fetch with after_seq ${oldest - 1} to read them)`;
			},
		},
	});

	return {
		text: rendered.text,
		consumedSeq,
		total: rendered.total,
		verbatim: rendered.verbatim,
		headlines: rendered.headlines,
		collapsed: rendered.collapsed,
		chars: rendered.chars,
	};
}

export { capText };
