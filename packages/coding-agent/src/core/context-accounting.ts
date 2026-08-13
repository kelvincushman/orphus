/**
 * Per-session accounting of what tool results actually put into the model's
 * context window.
 *
 * The room digest makes its cost observable by construction: a budget in, a
 * bounded string out. Tool results have no equivalent — a result either enters
 * context whole or, past {@link DEFAULT_MAX_RESULT_SIZE_CHARS}, is replaced by a
 * file reference, and nothing records which happened or what it cost. That gap
 * matters because the work of bounding the remaining boundaries is judged on
 * whether parent context actually shrank, and "actually" needs a number.
 *
 * This module is the number. It is deliberately a pure accumulator: no I/O, no
 * clock, no session coupling, so it can be asserted against directly.
 */

/** One tool result's contribution to the context window. */
export interface ToolContextRecord {
	readonly toolName: string;
	/** Characters that entered the model's context — post-spill, post-extension-hook. */
	readonly chars: number;
	/** Characters the result carried before any spill substitution. */
	readonly originalChars: number;
	/** True when an oversized result was replaced by a file reference. */
	readonly spilled: boolean;
}

/** Aggregate figures, for the whole session or for one tool. */
export interface ToolContextTotals {
	readonly calls: number;
	readonly chars: number;
	readonly originalChars: number;
	/** Number of results replaced by a file reference. */
	readonly spilled: number;
}

const ZERO: ToolContextTotals = { calls: 0, chars: 0, originalChars: 0, spilled: 0 };

function add(totals: ToolContextTotals, record: ToolContextRecord): ToolContextTotals {
	return {
		calls: totals.calls + 1,
		chars: totals.chars + record.chars,
		originalChars: totals.originalChars + record.originalChars,
		spilled: totals.spilled + (record.spilled ? 1 : 0),
	};
}

/**
 * Accumulates {@link ToolContextRecord}s for one session.
 *
 * Only per-tool aggregates are kept, not a record per call: a long session makes
 * thousands of tool calls, and the question this answers — which tools dominate
 * my context, and how much did spilling save — needs sums, not a log.
 */
export class ContextAccounting {
	private readonly perTool = new Map<string, ToolContextTotals>();
	private session: ToolContextTotals = ZERO;

	record(entry: ToolContextRecord): void {
		this.session = add(this.session, entry);
		this.perTool.set(entry.toolName, add(this.perTool.get(entry.toolName) ?? ZERO, entry));
	}

	/** Session-wide totals across every tool. */
	totals(): ToolContextTotals {
		return this.session;
	}

	/** Per-tool totals, heaviest context contributor first. */
	byTool(): ReadonlyMap<string, ToolContextTotals> {
		const sorted = [...this.perTool.entries()].sort((a, b) => b[1].chars - a[1].chars);
		return new Map(sorted);
	}

	/**
	 * One line naming the heaviest contributors, for the footer and the
	 * end-of-session summary. Empty string when no tool has run, so a caller can
	 * skip rendering without a separate emptiness check.
	 */
	summary(limit = 3): string {
		if (this.session.calls === 0) return "";
		const top = [...this.byTool().entries()]
			.slice(0, limit)
			.map(([name, totals]) => `${name} ${formatChars(totals.chars)}`)
			.join(", ");
		const saved = this.session.originalChars - this.session.chars;
		const savedNote = saved > 0 ? `, ${formatChars(saved)} spilled to disk` : "";
		return `context from tools: ${formatChars(this.session.chars)} over ${this.session.calls} call${
			this.session.calls === 1 ? "" : "s"
		} (${top})${savedNote}`;
	}
}

/**
 * Read-only view for consumers — the footer, the session summary, evals.
 * Excludes {@link ContextAccounting.record}, which belongs to the tool hook that
 * owns the measurement.
 */
export type ReadonlyContextAccounting = Pick<ContextAccounting, "totals" | "byTool" | "summary">;

/** Compact character counts: 812, 4.2k, 1.3M. */
export function formatChars(chars: number): string {
	if (chars < 1000) return String(chars);
	if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}k`;
	return `${(chars / 1_000_000).toFixed(1)}M`;
}
