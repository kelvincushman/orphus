import assert from "node:assert/strict";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { SessionInfo } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	DEFAULT_TUI_BACKEND,
	ENV_TUI_BACKEND,
	resolveTuiBackend,
} from "../../packages/coding-agent/src/core/terminal/backend.js";
import { keyboardEventToData } from "../../packages/coding-agent/src/core/terminal/keyboard-bridge.js";
import { ListSelectorModel } from "../../packages/coding-agent/src/core/terminal/list-selector-model.js";
import { SessionSelectorModel } from "../../packages/coding-agent/src/core/terminal/session-selector-model.js";
import { applyListKey } from "../../packages/coding-agent/src/core/terminal/termdom-backend.js";

function session(overrides: Partial<SessionInfo> & { path: string }): SessionInfo {
	return {
		id: overrides.path.replace(/\W/g, ""),
		cwd: "/work",
		modified: new Date("2026-01-01T00:00:00Z"),
		allMessagesText: "",
		...overrides,
	} as SessionInfo;
}

const CHILD = session({
	path: "/s/child.jsonl",
	id: "child",
	parentSessionPath: "/s/parent.jsonl",
	modified: new Date("2026-01-03T00:00:00Z"),
} as never);
const PARENT = session({ path: "/s/parent.jsonl", id: "parent", modified: new Date("2026-01-02T00:00:00Z") });
const NAMED = session({
	path: "/s/named.jsonl",
	id: "named",
	name: "Release prep",
	modified: new Date("2026-01-04T00:00:00Z"),
	allMessagesText: "cut the release",
});
const ALL = [PARENT, CHILD, NAMED];

function model(options?: ConstructorParameters<typeof SessionSelectorModel>[0]) {
	const subject = new SessionSelectorModel(options);
	subject.setSessions("current", ALL);
	return subject;
}

test("threaded mode with no query shows the parent/child tree", () => {
	const subject = model();
	const rows = subject.getState().rows;
	assert.deepEqual(
		rows.map((row) => [row.session.id, row.depth]),
		[
			["named", 0],
			["parent", 0],
			["child", 1],
		],
	);
});

test("a search flattens the tree rather than leaving holes in it", () => {
	const subject = model();
	subject.setQuery("release");
	const rows = subject.getState().rows;
	assert.deepEqual(
		rows.map((row) => [row.session.id, row.depth]),
		[["named", 0]],
	);
});

test("the named filter keeps only sessions with a name", () => {
	const subject = model();
	subject.toggleNameFilter();
	assert.equal(subject.getState().nameFilter, "named");
	assert.deepEqual(
		subject.getState().rows.map((row) => row.session.id),
		["named"],
	);
	subject.toggleNameFilter();
	assert.equal(subject.getState().rows.length, 3);
});

test("sort mode cycles threaded → recent → relevance → threaded", () => {
	const subject = model();
	const seen = [subject.getState().sortMode];
	for (let i = 0; i < 3; i++) {
		subject.cycleSortMode();
		seen.push(subject.getState().sortMode);
	}
	assert.deepEqual(seen, ["threaded", "recent", "relevance", "threaded"]);
});

test("scope toggles between the current project and everything, each loaded independently", () => {
	const subject = model();
	subject.toggleScope();
	assert.equal(subject.getState().scope, "all");
	assert.equal(subject.getState().loading, true, "the other scope has not been loaded yet");
	assert.deepEqual(subject.getState().rows, []);

	subject.setSessions("all", [PARENT]);
	assert.equal(subject.getState().loading, false);
	assert.deepEqual(
		subject.getState().rows.map((row) => row.session.id),
		["parent"],
	);
});

test("selection is clamped to the rows that exist", () => {
	const subject = model();
	subject.move(50);
	assert.equal(subject.getState().selectedIndex, 2);
	subject.move(-50);
	assert.equal(subject.getState().selectedIndex, 0);
	subject.select(1);
	assert.equal(subject.selected?.id, "parent");
	subject.select(99);
	assert.equal(subject.selected?.id, "parent", "an out-of-range index is ignored");
});

test("the current session can never be deleted", () => {
	const subject = model({ currentSessionPath: "/s/named.jsonl" });
	subject.select(0);
	assert.equal(subject.selected?.path, "/s/named.jsonl");

	const result = subject.requestDelete();

	assert.equal(result.ok, false);
	assert.equal(subject.getState().mode, "list", "no confirmation is offered for the active session");
	assert.equal(subject.getState().error, "Cannot delete the currently active session");
});

test("deleting any other session asks first, and removes it from both scopes on confirm", () => {
	const subject = model({ currentSessionPath: "/s/named.jsonl" });
	subject.setSessions("all", ALL);
	subject.select(1);
	assert.equal(subject.selected?.id, "parent");

	assert.equal(subject.requestDelete().ok, true);
	assert.equal(subject.getState().mode, "confirm-delete");
	assert.equal(subject.getState().confirmingDeletePath, "/s/parent.jsonl");

	subject.removeSession("/s/parent.jsonl");
	assert.equal(subject.getState().mode, "list");
	assert.ok(!subject.getState().rows.some((row) => row.session.path === "/s/parent.jsonl"));
	subject.toggleScope();
	assert.ok(!subject.getState().rows.some((row) => row.session.path === "/s/parent.jsonl"));
});

test("cancelling a delete leaves the session alone", () => {
	const subject = model();
	subject.select(1);
	subject.requestDelete();
	subject.cancelDelete();
	assert.equal(subject.getState().mode, "list");
	assert.equal(subject.getState().rows.length, 3);
});

test("rename edits the draft, and committing applies the new name", () => {
	const subject = model();
	subject.select(0);
	assert.equal(subject.startRename().ok, true);
	assert.equal(subject.getState().mode, "rename");
	assert.equal(subject.getState().renameDraft, "Release prep");

	subject.setRenameDraft("Shipped");
	const committed = subject.commitRename();

	assert.deepEqual(committed, { path: "/s/named.jsonl", name: "Shipped" });
	assert.equal(subject.getState().mode, "list");
	assert.equal(subject.getState().rows.find((row) => row.session.path === "/s/named.jsonl")?.session.name, "Shipped");
});

test("cancelling a rename discards the draft", () => {
	const subject = model();
	subject.select(0);
	subject.startRename();
	subject.setRenameDraft("Discarded");
	subject.cancelRename();
	assert.equal(subject.getState().mode, "list");
	assert.equal(subject.getState().rows[0]?.session.name, "Release prep");
});

test("path visibility toggles without disturbing the list", () => {
	const subject = model();
	assert.equal(subject.getState().showPath, false);
	subject.togglePath();
	assert.equal(subject.getState().showPath, true);
	assert.equal(subject.getState().rows.length, 3);
});

test("subscribers see every state change", () => {
	const subject = model();
	let notifications = 0;
	const unsubscribe = subject.subscribe(() => {
		notifications += 1;
	});
	subject.move(1);
	subject.setQuery("x");
	subject.togglePath();
	assert.equal(notifications, 3);
	unsubscribe();
	subject.move(-1);
	assert.equal(notifications, 3, "an unsubscribed listener stops hearing");
});

test("backend precedence is env, then setting, then the release default", () => {
	assert.deepEqual(resolveTuiBackend({ env: {}, setting: undefined }), {
		backend: DEFAULT_TUI_BACKEND,
		source: "default",
	});
	assert.deepEqual(resolveTuiBackend({ env: {}, setting: "termdom" }), { backend: "termdom", source: "setting" });
	assert.deepEqual(resolveTuiBackend({ env: { [ENV_TUI_BACKEND]: "pi" }, setting: "termdom" }), {
		backend: "pi",
		source: "env",
	});
});

test("the release default is pi, so termdom stays opt-in for this release", () => {
	assert.equal(DEFAULT_TUI_BACKEND, "pi");
});

test("an unrecognized backend falls back with a warning rather than failing startup", () => {
	const fromEnv = resolveTuiBackend({ env: { [ENV_TUI_BACKEND]: "ncurses" } });
	assert.equal(fromEnv.backend, "pi");
	assert.match(fromEnv.warning ?? "", /expected "pi" or "termdom"/);

	const fromSetting = resolveTuiBackend({ env: {}, setting: "ncurses" });
	assert.equal(fromSetting.backend, "pi");
	assert.match(fromSetting.warning ?? "", /tui\.backend="ncurses"/);
});

test("a bad env value falls through to a valid setting instead of eclipsing it", () => {
	const resolved = resolveTuiBackend({ env: { [ENV_TUI_BACKEND]: "ncurses" }, setting: "termdom" });
	assert.equal(resolved.backend, "termdom");
	assert.equal(resolved.source, "setting");
	assert.match(resolved.warning ?? "", /Ignoring ORPHUS_TUI_BACKEND="ncurses"/);
});

test("keyboard events re-encode to the bytes the keybinding layer matches", () => {
	assert.equal(keyboardEventToData({ key: "ArrowUp" }), "\x1b[A");
	assert.equal(keyboardEventToData({ key: "ArrowDown" }), "\x1b[B");
	assert.equal(keyboardEventToData({ key: "Enter" }), "\r");
	assert.equal(keyboardEventToData({ key: "Escape" }), "\x1b");
	assert.equal(keyboardEventToData({ key: "Tab" }), "\t");
	assert.equal(keyboardEventToData({ key: "Backspace" }), "\x7f");
	assert.equal(keyboardEventToData({ key: "Backspace", ctrlKey: true }), "\x08");
	assert.equal(keyboardEventToData({ key: "d", ctrlKey: true }), "\x04");
	assert.equal(keyboardEventToData({ key: "P", ctrlKey: true }), "\x10");
	assert.equal(keyboardEventToData({ key: "a" }), "a");
	assert.equal(keyboardEventToData({ key: "a", altKey: true }), "\x1ba");
	assert.equal(keyboardEventToData({ key: "é" }), "é");
	// A single astral code point is one keystroke even though `key.length` is 2.
	assert.equal(keyboardEventToData({ key: "🚀" }), "🚀");
	assert.equal(keyboardEventToData({ key: "Shift" }), undefined, "a bare modifier is not a keystroke");
	assert.equal(keyboardEventToData({ key: "F13" }), undefined);
});

test("the startup list filters, moves, and reports the original index of what was chosen", () => {
	const model = new ListSelectorModel("Pick a provider", [
		{ label: "Anthropic" },
		{ label: "OpenAI" },
		{ label: "Google" },
	]);

	assert.equal(model.getState().rows.length, 3);
	model.move(2);
	assert.equal(model.selectedOriginalIndex, 2);

	model.setQuery("open");
	assert.deepEqual(
		model.getState().rows.map((row) => row.choice.label),
		["OpenAI"],
	);
	assert.equal(model.selectedOriginalIndex, 1, "the index is into the original list, not the filtered one");

	model.setQuery("nothing matches");
	assert.equal(model.selectedOriginalIndex, undefined);
});

test("startup-list keys go through the same keybinding configuration", () => {
	const keybindings = KeybindingsManager.create();
	const model = new ListSelectorModel("Pick", [{ label: "first" }, { label: "second" }]);

	assert.equal(applyListKey("\x1b[B", keybindings, model), undefined);
	assert.equal(model.getState().selectedIndex, 1);
	assert.deepEqual(applyListKey("\r", keybindings, model), { outcome: "selected", index: 1 });
	assert.deepEqual(applyListKey("\x1b", keybindings, model), { outcome: "cancelled" });

	applyListKey("s", keybindings, model);
	assert.equal(model.getState().query, "s");
	applyListKey("\x7f", keybindings, model);
	assert.equal(model.getState().query, "");
});

test("an empty startup list cannot be confirmed into a selection", () => {
	const keybindings = KeybindingsManager.create();
	const model = new ListSelectorModel("Pick", []);
	assert.equal(applyListKey("\r", keybindings, model), undefined);
});
