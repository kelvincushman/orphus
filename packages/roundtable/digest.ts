import type { RoomMessage } from "./types.ts";

/**
 * Token-budget protection for inter-agent chat.
 *
 * A digest is the default way room content enters an agent's context window;
 * explicit replay is separately bounded and paginated.
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
  /** Total character budget for the complete digest response. Default 2000. */
  budget?: number;
  /** Characters reserved by the caller for response framing such as a header. */
  reservedChars?: number;
  /** Per-message cap for verbatim bodies. Default 600. */
  perMessageCap?: number;
  /** Cap for headline fragments. Default 100. */
  headlineCap?: number;
}

export interface Digest {
  /** Rendered digest body, guaranteed to fit the unreserved budget. */
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
export const MAX_DIGEST_BUDGET = 8000;
const DEFAULT_PER_MESSAGE_CAP = 600;
const DEFAULT_HEADLINE_CAP = 100;

export function normalizeDigestBudget(requestedBudget: number = DEFAULT_BUDGET): number {
  return Number.isFinite(requestedBudget)
    ? Math.min(Math.max(requestedBudget, 200), MAX_DIGEST_BUDGET)
    : DEFAULT_BUDGET;
}

function clock(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
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
  const budget = normalizeDigestBudget(options.budget);
  const requestedReserve = options.reservedChars ?? 0;
  const reservedChars = Number.isFinite(requestedReserve)
    ? Math.min(Math.max(Math.floor(requestedReserve), 0), budget)
    : 0;
  const bodyBudget = budget - reservedChars;
  const perMessageCap = Math.max(options.perMessageCap ?? DEFAULT_PER_MESSAGE_CAP, 80);
  const headlineCap = Math.max(options.headlineCap ?? DEFAULT_HEADLINE_CAP, 40);

  if (messages.length === 0) {
    const text = "No new messages.".slice(0, bodyBudget);
    return { text, consumedSeq: 0, total: 0, verbatim: 0, headlines: 0, collapsed: 0, chars: text.length };
  }

  const newestFirst = [...messages].sort((a, b) => b.seq - a.seq);
  const consumedSeq = newestFirst[0]?.seq ?? 0;

  const verbatimLines: string[] = [];
  const headlineLines: string[] = [];
  let collapsed = 0;
  let spent = 0;
  let tier: "verbatim" | "headline" = "verbatim";

  for (const message of newestFirst) {
    if (tier === "verbatim") {
      const line = renderVerbatim(message, perMessageCap);
      if (spent + line.length + 1 <= bodyBudget) {
        verbatimLines.push(line);
        spent += line.length + 1;
        continue;
      }
      tier = "headline";
    }
    const headline = renderHeadline(message, headlineCap);
    if (spent + headline.length + 1 <= bodyBudget) {
      headlineLines.push(headline);
      spent += headline.length + 1;
    } else {
      collapsed += 1;
    }
  }

  let collapseMarker = "";
  if (collapsed > 0) {
    const compactMarker = () => `(${collapsed} older collapsed)`;
    while (spent + compactMarker().length + 1 > bodyBudget) {
      const removed = headlineLines.pop() ?? verbatimLines.pop();
      if (!removed) break;
      spent -= removed.length + 1;
      collapsed += 1;
    }
    const detailedMarker = `(${collapsed} older message${collapsed === 1 ? "" : "s"} collapsed — raise budget or replay by seq to expand)`;
    collapseMarker = spent + detailedMarker.length + 1 <= bodyBudget ? detailedMarker : compactMarker();
    if (spent + collapseMarker.length + 1 > bodyBudget) collapseMarker = "";
  }

  const parts: string[] = [];
  if (collapseMarker) parts.push(collapseMarker);
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
