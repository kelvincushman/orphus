/**
 * The tiering core behind every bounded rendering in Orphus.
 *
 * Given a list of items and a character budget, spend the budget on the items
 * that matter most, degrade the rest to one-line headlines, and collapse
 * whatever is left into a single count. The output is at most `budget`
 * characters plus one marker line, no matter what the items contain — which is
 * the property that makes a boundary a bound rather than a hope.
 *
 * This started as the room digest and is now shared, because the same guarantee
 * is wanted at more than one boundary: a room's messages reaching an agent, and
 * a subagent's output reaching its parent. Extracting it rather than copying it
 * means the guarantee has one implementation and one set of tests, so the two
 * cannot drift into disagreeing about what "bounded" means.
 *
 * Deliberately not model-shaped: no tokenizer, no summarisation, no network.
 * Deterministic in, deterministic out — a verbose or hostile item cannot
 * inflate what a reader pays, because the budget is enforced before rendering
 * ever finishes.
 */

/** How each tier turns an item into a line. Every caller supplies its own. */
export interface BoundedRenderFormat<T> {
	/** The body used for capping and for taking a headline's first line. */
	text(item: T): string;
	/** Full form, once the item is known to fit. `truncated` is chars dropped by the per-item cap. */
	verbatim(item: T, cappedText: string, truncated: number): string;
	/** One-line form. `hasMore` is true when the body continued past what is shown. */
	headline(item: T, cappedFirstLine: string, hasMore: boolean): string;
	/** The single marker line standing in for everything that did not fit. */
	collapsed(count: number): string;
}

export interface BoundedRenderOptions<T> {
	/** Total character budget for the body. Floored at 200. Default 2000. */
	budget?: number;
	/** Per-item cap for verbatim bodies. Floored at 80. Default 600. */
	perItemCap?: number;
	/** Cap for headline fragments. Floored at 40. Default 100. */
	headlineCap?: number;
	/**
	 * Keep the input order in the output. Default false, which reverses — the
	 * room spends budget newest-first but reads oldest-first, so its highest
	 * priority item is rendered last.
	 */
	preserveOrder?: boolean;
	format: BoundedRenderFormat<T>;
}

export interface BoundedRenderResult {
	/** Rendered body, guaranteed ≤ budget + one marker line. */
	text: string;
	total: number;
	verbatim: number;
	headlines: number;
	collapsed: number;
	chars: number;
}

export const DEFAULT_BUDGET = 2000;
export const DEFAULT_PER_ITEM_CAP = 600;
export const DEFAULT_HEADLINE_CAP = 100;

const MIN_BUDGET = 200;
const MIN_PER_ITEM_CAP = 80;
const MIN_HEADLINE_CAP = 40;

export function capText(text: string, cap: number): { text: string; truncated: number } {
	const oneLineSafe = text.trimEnd();
	if (oneLineSafe.length <= cap) return { text: oneLineSafe, truncated: 0 };
	return { text: oneLineSafe.slice(0, cap), truncated: oneLineSafe.length - cap };
}

/**
 * Render `items` within a character budget.
 *
 * Items arrive in **priority order**: the first is served first. Budget is spent
 * down the list, so what the caller puts first is what survives verbatim.
 */
export function boundedRender<T>(items: readonly T[], options: BoundedRenderOptions<T>): BoundedRenderResult {
	const budget = Math.max(options.budget ?? DEFAULT_BUDGET, MIN_BUDGET);
	const perItemCap = Math.max(options.perItemCap ?? DEFAULT_PER_ITEM_CAP, MIN_PER_ITEM_CAP);
	const headlineCap = Math.max(options.headlineCap ?? DEFAULT_HEADLINE_CAP, MIN_HEADLINE_CAP);
	const { format } = options;

	const verbatimLines: string[] = [];
	const headlineLines: string[] = [];
	let collapsed = 0;
	let spent = 0;
	let tier: "verbatim" | "headline" = "verbatim";

	for (const [index, item] of items.entries()) {
		const body = format.text(item);
		if (tier === "verbatim") {
			const capped = capText(body, perItemCap);
			const line = format.verbatim(item, capped.text, capped.truncated);
			if (spent + line.length + 1 <= budget) {
				verbatimLines.push(line);
				spent += line.length + 1;
				continue;
			}
			tier = "headline";
		}
		const firstLine = body.split("\n", 1)[0] ?? "";
		const cappedHeadline = capText(firstLine, headlineCap);
		const hasMore = cappedHeadline.truncated > 0 || body.length > firstLine.length;
		const headline = format.headline(item, cappedHeadline.text, hasMore);
		if (spent + headline.length + 1 <= budget) {
			headlineLines.push(headline);
			spent += headline.length + 1;
			continue;
		}
		// Once one headline does not fit, everything after it is collapsed too.
		// Continuing to try would let a shorter lower-priority item win a slot
		// above items counted as collapsed, so the marker would sit above lines
		// that outrank some of what it counts. Budget is spent in priority order;
		// the rendering has to stay consistent with that.
		collapsed = items.length - index;
		break;
	}

	const parts: string[] = [];
	if (collapsed > 0) parts.push(format.collapsed(collapsed));
	if (options.preserveOrder) {
		parts.push(...verbatimLines, ...headlineLines);
	} else {
		parts.push(...headlineLines.reverse());
		parts.push(...verbatimLines.reverse());
	}

	const text = parts.join("\n");
	return {
		text,
		total: items.length,
		verbatim: verbatimLines.length,
		headlines: headlineLines.length,
		collapsed,
		chars: text.length,
	};
}
