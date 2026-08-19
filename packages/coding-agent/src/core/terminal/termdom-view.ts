import type { SessionInfo } from "../session-manager.ts";
import type { SessionSelectorState } from "./session-selector-model.ts";

/**
 * The width at or above which the detail panel appears.
 *
 * Below it the picker is a single column: a 40-column terminal that tries to
 * show a list and a detail panel side by side shows neither.
 */
export const DETAIL_PANEL_MIN_COLUMNS = 90;

export interface ViewportSize {
	columns: number;
	rows: number;
}

/** Escape text for embedding in HTML. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function formatDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function treePrefix(depth: number, isLast: boolean, ancestorContinues: boolean[]): string {
	if (depth === 0) return "";
	const trunk = ancestorContinues.slice(0, -1).map((continues) => (continues ? "│ " : "  "));
	return `${trunk.join("")}${isLast ? "└─" : "├─"}`;
}

const STYLES = `
	:host, .picker { display: flex; flex-direction: column; }
	.frame { border: 1px solid #5fafff; padding: 0 1ch; }
	.header { color: #5fafff; font-weight: bold; }
	.hint { color: #808080; }
	.search { color: #ffffff; }
	.body { display: flex; flex-direction: row; }
	.list { display: flex; flex-direction: column; flex-grow: 1; }
	.detail { width: 34ch; padding: 0 0 0 2ch; color: #b0b0b0; }
	.row { color: #d0d0d0; }
	.row.selected { color: #000000; background-color: #5fafff; }
	.row.current { color: #5fff87; }
	.meta { color: #808080; }
	.error { color: #ff5f5f; }
	.confirm { color: #ffaf5f; }
	.empty { color: #808080; }
`;

function renderRow(
	row: SessionSelectorState["rows"][number],
	index: number,
	state: SessionSelectorState,
	isCurrent: boolean,
): string {
	const classes = ["row"];
	if (index === state.selectedIndex) classes.push("selected");
	if (isCurrent) classes.push("current");
	const prefix = treePrefix(row.depth, row.isLast, row.ancestorContinues);
	const label = row.session.name?.trim() || row.session.id;
	const suffix = state.showPath ? `  ${row.session.path}` : "";
	return `<div class="${classes.join(" ")}" data-index="${index}">${escapeHtml(`${prefix}${label}${suffix}`)}</div>`;
}

function renderDetail(session: SessionInfo | undefined): string {
	if (!session) return `<div class="detail"><div class="meta">No session selected</div></div>`;
	const lines = [
		`<div class="header">${escapeHtml(session.name?.trim() || session.id)}</div>`,
		`<div class="meta">${escapeHtml(formatDate(session.modified))}</div>`,
		`<div class="meta">${escapeHtml(session.cwd)}</div>`,
		`<div class="meta">${escapeHtml(session.path)}</div>`,
	];
	return `<div class="detail">${lines.join("")}</div>`;
}

/**
 * Render the picker as HTML for termDOM to lay out.
 *
 * Pure, so a frame can be asserted without a terminal: feed the result to
 * `TermDOM.renderANSI` against a deterministic transport and the whole visual
 * contract — layout at a width, selection, tree prefixes, the detail panel's
 * appearance and disappearance — is testable headlessly.
 */
export function renderSelectorHtml(
	state: SessionSelectorState,
	size: ViewportSize,
	options?: { isCurrentSession?: (path: string) => boolean },
): string {
	const wide = size.columns >= DETAIL_PANEL_MIN_COLUMNS;
	const isCurrent = options?.isCurrentSession ?? (() => false);
	// Two lines of chrome above and two below, plus the search line.
	const visibleRows = Math.max(1, size.rows - 8);
	const start = Math.max(
		0,
		Math.min(state.selectedIndex - Math.floor(visibleRows / 2), state.rows.length - visibleRows),
	);
	const window = state.rows.slice(start, start + visibleRows);

	const header = [
		`<span class="header">Sessions</span>`,
		`<span class="hint"> ${escapeHtml(state.scope)} · ${escapeHtml(state.sortMode)} · ${escapeHtml(state.nameFilter)}</span>`,
	].join("");

	const listBody =
		state.rows.length === 0
			? `<div class="empty">${state.loading ? "Loading sessions…" : "No matching sessions"}</div>`
			: window.map((row, offset) => renderRow(row, start + offset, state, isCurrent(row.session.path))).join("");

	const banner = (() => {
		if (state.mode === "confirm-delete" && state.confirmingDeletePath) {
			return `<div class="confirm">Delete ${escapeHtml(state.confirmingDeletePath)}? enter to confirm, esc to cancel</div>`;
		}
		if (state.mode === "rename") {
			return `<div class="search">Rename: ${escapeHtml(state.renameDraft)}▏</div>`;
		}
		if (state.error) return `<div class="error">${escapeHtml(state.error)}</div>`;
		return "";
	})();

	const body = wide
		? `<div class="body"><div class="list">${listBody}</div>${renderDetail(state.rows[state.selectedIndex]?.session)}</div>`
		: `<div class="body"><div class="list">${listBody}</div></div>`;

	return [
		`<style>${STYLES}</style>`,
		`<div class="picker frame">`,
		`<div>${header}</div>`,
		`<div class="search">&gt; ${escapeHtml(state.query)}▏</div>`,
		banner,
		body,
		`<div class="hint">↑↓ move · enter open · tab scope · esc cancel</div>`,
		`</div>`,
	]
		.filter((part) => part.length > 0)
		.join("");
}
