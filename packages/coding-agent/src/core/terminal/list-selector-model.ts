export interface ListChoice {
	label: string;
	/** Optional second line, shown where the layout has room for it. */
	detail?: string;
}

export interface ListSelectorState {
	title: string;
	query: string;
	selectedIndex: number;
	/** Choices after filtering, with their index in the original list. */
	rows: { choice: ListChoice; index: number }[];
}

/**
 * The startup selection list, with no renderer in it.
 *
 * Deliberately much smaller than {@link SessionSelectorModel}: a startup picker
 * chooses one labelled thing from a short list, and giving it scopes, sort
 * modes, and a delete confirmation it has no use for would be inventing
 * behaviour to share rather than sharing behaviour. What it does share is the
 * shape — a model both backends drive — so parity is structural here too.
 */
export class ListSelectorModel {
	private readonly listeners = new Set<() => void>();
	private readonly choices: ListChoice[];
	private readonly title: string;
	private query = "";
	private selectedIndex = 0;
	private cachedRows: { choice: ListChoice; index: number }[];

	constructor(title: string, choices: ListChoice[]) {
		this.title = title;
		this.choices = choices;
		this.cachedRows = choices.map((choice, index) => ({ choice, index }));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getState(): ListSelectorState {
		return { title: this.title, query: this.query, selectedIndex: this.selectedIndex, rows: this.cachedRows };
	}

	/** The original index of the highlighted choice, or undefined when nothing matches. */
	get selectedOriginalIndex(): number | undefined {
		return this.cachedRows[this.selectedIndex]?.index;
	}

	setQuery(query: string): void {
		this.query = query;
		const needle = query.trim().toLowerCase();
		this.cachedRows = this.choices
			.map((choice, index) => ({ choice, index }))
			.filter(({ choice }) => !needle || choice.label.toLowerCase().includes(needle));
		this.selectedIndex = 0;
		this.notify();
	}

	move(delta: number): void {
		if (this.cachedRows.length === 0) return;
		this.selectedIndex = Math.min(Math.max(this.selectedIndex + delta, 0), this.cachedRows.length - 1);
		this.notify();
	}

	select(index: number): void {
		if (index < 0 || index >= this.cachedRows.length) return;
		this.selectedIndex = index;
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
