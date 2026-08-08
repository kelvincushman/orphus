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

const DEFAULT_BUDGET = 2000;
const DEFAULT_PER_MESSAGE_CAP = 600;
const DEFAULT_HEADLINE_CAP = 100;

function clock(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function capText(text: string, cap: number): { text: string; truncated: number } {
  const oneLineSafe = text.trimEnd();
  if (oneLineSafe.length <= cap) return { text: oneLineSafe, truncated: 0 };
  return { text: oneLineSafe.slice(0, cap), truncated: oneLineSafe.length - cap };
}

function renderVerbatim(message: RoomMessage, perMessageCap: number): string {
  const { text, truncated } = capText(message.text, perMessageCap);
  const marker = truncated > 0 ? ` …(+${truncated} chars)` : "";
  const reply = message.replyTo ? ` (reply to ${message.replyTo})` : "";
  return `[${clock(message.timestamp)}] ${message.from.name}#${message.seq}${reply}: ${text}${marker}`;
}

function renderHeadline(message: RoomMessage, headlineCap: number): string {
  const firstLine = message.text.split("\n", 1)[0] ?? "";
  const { text, truncated } = capText(firstLine, headlineCap);
  const marker = truncated > 0 || message.text.length > firstLine.length ? " …" : "";
  return `· ${message.from.name}#${message.seq}: ${text}${marker}`;
}

/**
 * Build a bounded digest from unread messages (ascending seq order expected).
 * Deterministic and model-free: the bound holds no matter what peers post.
 */
export function buildDigest(messages: readonly RoomMessage[], options: DigestOptions = {}): Digest {
  const budget = Math.max(options.budget ?? DEFAULT_BUDGET, 200);
  const perMessageCap = Math.max(options.perMessageCap ?? DEFAULT_PER_MESSAGE_CAP, 80);
  const headlineCap = Math.max(options.headlineCap ?? DEFAULT_HEADLINE_CAP, 40);

  if (messages.length === 0) {
    return { text: "No new messages.", consumedSeq: 0, total: 0, verbatim: 0, headlines: 0, collapsed: 0, chars: 0 };
  }

  const newestFirst = [...messages].sort((a, b) => b.seq - a.seq);
  const consumedSeq = newestFirst[0]?.seq ?? 0;

  const verbatimLines: string[] = [];
  const headlineLines: string[] = [];
  let collapsed = 0;
  let spent = 0;
  let tier: "verbatim" | "headline" = "verbatim";

  for (const [index, message] of newestFirst.entries()) {
    if (tier === "verbatim") {
      const line = renderVerbatim(message, perMessageCap);
      if (spent + line.length + 1 <= budget) {
        verbatimLines.push(line);
        spent += line.length + 1;
        continue;
      }
      tier = "headline";
    }
    const headline = renderHeadline(message, headlineCap);
    if (spent + headline.length + 1 <= budget) {
      headlineLines.push(headline);
      spent += headline.length + 1;
      continue;
    }
    // Once one headline does not fit, everything older than it is collapsed too.
    // Continuing to try would let a shorter older message win a slot above
    // messages counted as collapsed, so the "N older messages collapsed" marker
    // would sit above lines that are newer than some of what it counts. Budget
    // is spent newest-first; the rendering has to stay consistent with that.
    collapsed = newestFirst.length - index;
    break;
  }

  const parts: string[] = [];
  if (collapsed > 0) {
    parts.push(`(${collapsed} older message${collapsed === 1 ? "" : "s"} collapsed — raise budget or fetch by seq to expand)`);
  }
  // Tiers were filled newest-first; render oldest-first for chronological reading.
  parts.push(...headlineLines.reverse());
  parts.push(...verbatimLines.reverse());

  const text = parts.join("\n");
  return {
    text,
    consumedSeq,
    total: messages.length,
    verbatim: verbatimLines.length,
    headlines: headlineLines.length,
    collapsed,
    chars: text.length,
  };
}
