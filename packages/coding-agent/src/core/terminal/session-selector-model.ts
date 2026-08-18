import {
	filterAndSortSessions,
	hasSessionName,
	type NameFilter,
	type SortMode,
} from "../../modes/interactive/components/session-selector-search.ts";
import {
	buildSessionTree,
	type FlatSessionNode,
	flattenSessionTree,
} from "../../modes/interactive/components/session-selector-tree.ts";
import { canonicalizePath } from "../../modes/interactive/components/session-selector-utils.ts";
import type { SessionInfo } from "../session-manager.ts";

export type SessionScope = "current" | "all";
export type SelectorMode = "list" | "rename" | "confirm-delete";
export type { NameFilter, SortMode };

export interface SessionSelectorState {
	scope: SessionScope;
	sortMode: SortMode;
	nameFilter: NameFilter;
	query: string;
	showPath: boolean;
	mode: SelectorMode;
	selectedIndex: number;
	/** Rows as they should be displayed, after filtering, sorting, and tree flattening. */
	rows: FlatSessionNode[];
	loading: boolean;
	error: string | undefined;
	renameDraft: string;
	renameTargetPath: string | undefined;
	confirmingDeletePath: string | undefined;
}

export interface SessionSelectorModelOptions {
	/** Path of the session the user is currently in, which may never be deleted. */
	currentSessionPath?: string;
	/** Rows to show before the loaders resolve. */
	initialSessions?: SessionInfo[];
	initialScope?: SessionScope;
	initialSortMode?: SortMode;
	initialNameFilter?: NameFilter;
}

const SORT_MODES: SortMode[] = ["threaded", "recent", "relevance"];

/**
 * The session selector, with no renderer in it.
 *
 * Filtering, sorting, tree construction, scope and name-filter toggles,
 * selection movement, rename, delete confirmation, loading state, and the
 * current-session safeguard all live here. Both terminal backends drive this
 * same object, so "the termDOM picker behaves like the pi one" is a property of
 * the code rather than of two implementations kept in sync by hand — and every
 * one of those behaviours is testable without a terminal.
 */
export class SessionSelectorModel {
	private readonly listeners = new Set<() => void>();
	private readonly currentSessionCanonicalPath: string | undefined;
	private sessionsByScope: { current: SessionInfo[] | undefined; all: SessionInfo[] | undefined };

	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private query = "";
	private showPath = false;
	private mode: SelectorMode = "list";
	private selectedIndex = 0;
	private cachedRows: FlatSessionNode[] = [];
	private error: string | undefined;
	private renameDraft = "";
	private renameTargetPath: string | undefined;
	private confirmingDeletePath: string | undefined;

	constructor(options: SessionSelectorModelOptions = {}) {
		this.currentSessionCanonicalPath = canonicalizePath(options.currentSessionPath);
		this.scope = options.initialScope ?? "current";
		this.sortMode = options.initialSortMode ?? "threaded";
		this.nameFilter = options.initialNameFilter ?? "all";
		this.sessionsByScope = { current: options.initialSessions, all: undefined };
		this.recompute();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getState(): SessionSelectorState {
		return {
			scope: this.scope,
			sortMode: this.sortMode,
			nameFilter: this.nameFilter,
			query: this.query,
			showPath: this.showPath,
			mode: this.mode,
			selectedIndex: this.selectedIndex,
			rows: this.cachedRows,
			loading: this.sessionsByScope[this.scope] === undefined,
			error: this.error,
			renameDraft: this.renameDraft,
			renameTargetPath: this.renameTargetPath,
			confirmingDeletePath: this.confirmingDeletePath,
		};
	}

	get selected(): SessionInfo | undefined {
		return this.cachedRows[this.selectedIndex]?.session;
	}

	isCurrentSession(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	/** Hand the model a scope's sessions. Either scope may arrive at any time. */
	setSessions(scope: SessionScope, sessions: SessionInfo[]): void {
		this.sessionsByScope = { ...this.sessionsByScope, [scope]: sessions };
		this.recompute();
	}

	setQuery(query: string): void {
		this.query = query;
		this.selectedIndex = 0;
		this.recompute();
	}

	move(delta: number): void {
		if (this.cachedRows.length === 0) return;
		const next = this.selectedIndex + delta;
		this.selectedIndex = Math.min(Math.max(next, 0), this.cachedRows.length - 1);
		this.notify();
	}

	select(index: number): void {
		if (index < 0 || index >= this.cachedRows.length) return;
		this.selectedIndex = index;
		this.notify();
	}

	toggleScope(): void {
		this.scope = this.scope === "current" ? "all" : "current";
		this.selectedIndex = 0;
		this.recompute();
	}

	cycleSortMode(): void {
		const next = (SORT_MODES.indexOf(this.sortMode) + 1) % SORT_MODES.length;
		this.sortMode = SORT_MODES[next];
		this.selectedIndex = 0;
		this.recompute();
	}

	toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.selectedIndex = 0;
		this.recompute();
	}

	togglePath(): void {
		this.showPath = !this.showPath;
		this.notify();
	}

	setError(message: string | undefined): void {
		this.error = message;
		this.notify();
	}

	/**
	 * Ask to delete the selected session.
	 *
	 * The safeguard lives here rather than in a renderer: deleting the session
	 * you are sitting in is refused before any confirmation is offered, so no
	 * backend can offer it by forgetting to check.
	 */
	requestDelete(): { ok: boolean; reason?: string } {
		const selected = this.selected;
		if (!selected) return { ok: false, reason: "Nothing is selected" };
		if (this.isCurrentSession(selected.path)) {
			const reason = "Cannot delete the currently active session";
			this.error = reason;
			this.notify();
			return { ok: false, reason };
		}
		this.confirmingDeletePath = selected.path;
		this.mode = "confirm-delete";
		this.error = undefined;
		this.notify();
		return { ok: true };
	}

	cancelDelete(): void {
		this.confirmingDeletePath = undefined;
		this.mode = "list";
		this.notify();
	}

	/** Remove a deleted session from both scopes. */
	removeSession(path: string): void {
		const canonical = canonicalizePath(path) ?? path;
		const drop = (sessions: SessionInfo[] | undefined) =>
			sessions?.filter((session) => (canonicalizePath(session.path) ?? session.path) !== canonical);
		this.sessionsByScope = { current: drop(this.sessionsByScope.current), all: drop(this.sessionsByScope.all) };
		this.confirmingDeletePath = undefined;
		this.mode = "list";
		this.recompute();
	}

	startRename(): { ok: boolean; reason?: string } {
		const selected = this.selected;
		if (!selected) return { ok: false, reason: "Nothing is selected" };
		this.renameTargetPath = selected.path;
		this.renameDraft = selected.name ?? "";
		this.mode = "rename";
		this.notify();
		return { ok: true };
	}

	setRenameDraft(draft: string): void {
		this.renameDraft = draft;
		this.notify();
	}

	cancelRename(): void {
		this.mode = "list";
		this.renameTargetPath = undefined;
		this.renameDraft = "";
		this.notify();
	}

	/** Apply a rename locally and leave rename mode. Persisting is the caller's job. */
	commitRename(): { path: string; name: string } | undefined {
		const path = this.renameTargetPath;
		if (!path) return undefined;
		const name = this.renameDraft.trim();
		const apply = (sessions: SessionInfo[] | undefined) =>
			sessions?.map((session) => (session.path === path ? { ...session, name: name || undefined } : session));
		this.sessionsByScope = { current: apply(this.sessionsByScope.current), all: apply(this.sessionsByScope.all) };
		this.mode = "list";
		this.renameTargetPath = undefined;
		this.renameDraft = "";
		this.recompute();
		return { path, name };
	}

	/**
	 * Recompute the display rows.
	 *
	 * Threaded mode with no query is the only one that shows the parent/child
	 * tree; a search flattens it, because a filtered tree is a tree with holes
	 * in it and reads as a broken list rather than a filtered one.
	 */
	private recompute(): void {
		const sessions = this.sessionsByScope[this.scope] ?? [];
		const nameFiltered = this.nameFilter === "all" ? sessions : sessions.filter((session) => hasSessionName(session));
		const trimmed = this.query.trim();
		if (this.sortMode === "threaded" && !trimmed) {
			this.cachedRows = flattenSessionTree(buildSessionTree(nameFiltered));
		} else {
			this.cachedRows = filterAndSortSessions(nameFiltered, this.query, this.sortMode, "all").map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.cachedRows.length - 1));
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
