import type { ListSelectorState } from "./list-selector-model.ts";
import { escapeHtml, type ViewportSize } from "./termdom-view.ts";

/** Width at or above which a choice's detail line is shown beside its label. */
export const LIST_DETAIL_MIN_COLUMNS = 70;

const STYLES = `
	.list-frame { border: 1px solid #5fafff; padding: 0 1ch; display: flex; flex-direction: column; }
	.list-title { color: #5fafff; font-weight: bold; }
	.list-search { color: #ffffff; }
	.list-row { color: #d0d0d0; }
	.list-row.selected { color: #000000; background-color: #5fafff; }
	.list-detail { color: #808080; }
	.list-empty { color: #808080; }
	.list-hint { color: #808080; }
`;

/**
 * Render the startup selection list.
 *
 * Pure, like the session-picker view, so a frame is assertable without a
 * terminal. Detail lines are dropped rather than wrapped on a narrow terminal:
 * a two-line row that wraps to four is harder to scan than one without a
 * subtitle.
 */
export function renderListSelectorHtml(state: ListSelectorState, size: ViewportSize): string {
	const wide = size.columns >= LIST_DETAIL_MIN_COLUMNS;
	const visibleRows = Math.max(1, size.rows - 6);
	const start = Math.max(
		0,
		Math.min(state.selectedIndex - Math.floor(visibleRows / 2), state.rows.length - visibleRows),
	);
	const rows = state.rows.slice(start, start + visibleRows);

	const body =
		rows.length === 0
			? `<div class="list-empty">No matches</div>`
			: rows
					.map((row, offset) => {
						const index = start + offset;
						const selected = index === state.selectedIndex ? " selected" : "";
						const detail =
							wide && row.choice.detail
								? `<div class="list-detail">  ${escapeHtml(row.choice.detail)}</div>`
								: "";
						return `<div class="list-row${selected}" data-index="${index}">${escapeHtml(row.choice.label)}</div>${detail}`;
					})
					.join("");

	return [
		`<style>${STYLES}</style>`,
		`<div class="list-frame">`,
		`<div class="list-title">${escapeHtml(state.title)}</div>`,
		`<div class="list-search">&gt; ${escapeHtml(state.query)}\u258f</div>`,
		body,
		`<div class="list-hint">\u2191\u2193 move \u00b7 enter choose \u00b7 esc cancel</div>`,
		`</div>`,
	].join("");
}
