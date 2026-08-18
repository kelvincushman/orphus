/**
 * Turn a DOM keyboard event back into the raw terminal bytes it came from.
 *
 * termDOM decodes stdin into `KeyboardEvent`s, which is the right shape for a
 * DOM app but the wrong shape for this codebase: keybindings are configured and
 * matched against raw key data by {@link KeybindingsManager}. Re-encoding here
 * means both backends consult the *same* keybinding configuration, so keyboard
 * parity is a property of the code rather than of two tables kept in step by
 * hand.
 */

export interface KeyboardEventLike {
	key: string;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	metaKey?: boolean;
}

/** Named keys with a fixed terminal encoding. */
const NAMED_KEYS: Record<string, string> = {
	ArrowUp: "\x1b[A",
	ArrowDown: "\x1b[B",
	ArrowRight: "\x1b[C",
	ArrowLeft: "\x1b[D",
	Home: "\x1b[H",
	End: "\x1b[F",
	PageUp: "\x1b[5~",
	PageDown: "\x1b[6~",
	Delete: "\x1b[3~",
	Insert: "\x1b[2~",
	Enter: "\r",
	Tab: "\t",
	Escape: "\x1b",
	Backspace: "\x7f",
	" ": " ",
};

/**
 * Encode a keyboard event as terminal input.
 *
 * Returns undefined for a key with no terminal representation (a bare modifier,
 * a function key this build does not map), which callers treat as "not for us"
 * rather than as an empty keystroke.
 */
export function keyboardEventToData(event: KeyboardEventLike): string | undefined {
	// Backtab has its own sequence — pi's key matcher reads \x1b[Z as
	// "shift+tab" — so encoding it as plain Tab would fire Tab's binding.
	if (event.key === "Tab" && event.shiftKey) return "\x1b[Z";
	const named = NAMED_KEYS[event.key];
	if (named !== undefined) {
		// Ctrl+Backspace has its own encoding; everything else named ignores
		// Ctrl, matching what terminals actually send.
		if (event.ctrlKey && event.key === "Backspace") return "\x08";
		if (event.altKey && named.length === 1) return `\x1b${named}`;
		return named;
	}
	// One code point, not one UTF-16 unit: an emoji is a single keystroke whose
	// `key` has length 2, and dropping it would make astral characters untypable.
	if ([...event.key].length !== 1) return undefined;

	if (event.ctrlKey) {
		const upper = event.key.toUpperCase();
		const code = upper.charCodeAt(0);
		// Ctrl+A..Ctrl+Z are 0x01..0x1a; Ctrl+[\]^_ follow the same offset.
		if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
		return undefined;
	}
	if (event.altKey) return `\x1b${event.key}`;
	return event.key;
}
