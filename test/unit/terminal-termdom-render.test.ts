import assert from "node:assert/strict";
import { TermDOM } from "@b9g/termdom";
import { afterEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { SessionInfo } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionSelectorModel } from "../../packages/coding-agent/src/core/terminal/session-selector-model.js";
import { applyKey, TermDomSelectorHost } from "../../packages/coding-agent/src/core/terminal/termdom-backend.js";
import {
	DETAIL_PANEL_MIN_COLUMNS,
	renderSelectorHtml,
} from "../../packages/coding-agent/src/core/terminal/termdom-view.js";
import { createFakeTerminalTransport } from "./terminal-fake-transport.js";

/** A full termDOM boot is process-shaped work, not a slow assertion. */
const TERMDOM_ATTACH_TIMEOUT_MS = 60_000;

const hosts: TermDomSelectorHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose();
});

function session(path: string, name: string | undefined, modified: string): SessionInfo {
	return {
		id: path.replace(/\W/g, ""),
		path,
		cwd: "/work/project",
		modified: new Date(modified),
		allMessagesText: "",
		...(name ? { name } : {}),
	} as SessionInfo;
}

const SESSIONS = [
	session("/s/one.jsonl", "First session", "2026-01-04T00:00:00Z"),
	session("/s/two.jsonl", "Second session", "2026-01-03T00:00:00Z"),
	session("/s/three.jsonl", undefined, "2026-01-02T00:00:00Z"),
];

function model(sessions = SESSIONS, currentSessionPath?: string) {
	const subject = new SessionSelectorModel({ currentSessionPath });
	subject.setSessions("current", sessions);
	return subject;
}

/** Strip ANSI so a frame can be asserted on its text. */
function plain(ansi: string): string {
	return ansi.replace(/\x1b\[[0-9;]*m/g, "");
}

async function renderFrame(html: string, cols: number, rows = 30): Promise<string> {
	const transport = createFakeTerminalTransport({ cols, rows });
	const dom = new TermDOM({ transport });
	try {
		return dom.renderANSI(html);
	} finally {
		await dom.dispose();
	}
}

test(
	"a wide terminal shows the list and a detail panel",
	async () => {
		const subject = model();
		const html = renderSelectorHtml(subject.getState(), { columns: 120, rows: 30 });
		const frame = plain(await renderFrame(html, 120));

		assert.match(frame, /First session/);
		assert.match(frame, /Second session/);
		// The detail panel's distinguishing content is the selected session's path.
		assert.match(frame, /\/s\/one\.jsonl/);
		assert.match(frame, /\/work\/project/);
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);

test(
	"a narrow terminal drops to a single column and omits the detail panel",
	async () => {
		const subject = model();
		const html = renderSelectorHtml(subject.getState(), { columns: DETAIL_PANEL_MIN_COLUMNS - 1, rows: 30 });
		const frame = plain(await renderFrame(html, DETAIL_PANEL_MIN_COLUMNS - 1));

		assert.match(frame, /First session/, "the list survives at every width");
		assert.ok(!frame.includes("/s/one.jsonl"), "the detail panel is gone, not squeezed");
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);

test(
	"no frame line exceeds the terminal width, at either size",
	async () => {
		const subject = model();
		for (const columns of [DETAIL_PANEL_MIN_COLUMNS - 1, 120]) {
			const html = renderSelectorHtml(subject.getState(), { columns, rows: 30 });
			const frame = plain(await renderFrame(html, columns));
			for (const line of frame.split("\n")) {
				assert.ok(line.length <= columns, `line of ${line.length} exceeded ${columns} columns`);
			}
		}
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);

test(
	"CJK, RTL, and emoji session names render without breaking the layout",
	async () => {
		const subject = model([
			session("/s/cjk.jsonl", "セッション一覧", "2026-01-04T00:00:00Z"),
			session("/s/rtl.jsonl", "جلسة العمل", "2026-01-03T00:00:00Z"),
			session("/s/emoji.jsonl", "ship it 🚀🚀", "2026-01-02T00:00:00Z"),
		]);
		const html = renderSelectorHtml(subject.getState(), { columns: 100, rows: 30 });
		const frame = plain(await renderFrame(html, 100));

		assert.match(frame, /セッション/);
		assert.match(frame, /🚀/);
		for (const line of frame.split("\n")) assert.ok(line.length <= 100);
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);

test(
	"a 500-session list renders only a window of rows",
	async () => {
		const many = Array.from({ length: 500 }, (_, index) =>
			session(
				`/s/session-${index}.jsonl`,
				`Session ${index}`,
				`2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
			),
		);
		const subject = model(many);
		const html = renderSelectorHtml(subject.getState(), { columns: 100, rows: 30 });
		const frame = plain(await renderFrame(html, 100));

		const shown = [...frame.matchAll(/Session \d+/g)].length;
		assert.ok(shown > 0, "something is displayed");
		assert.ok(shown <= 30, `expected at most a screenful, saw ${shown}`);
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);

test("the frame marks the selection and the current session distinctly", () => {
	const subject = model(SESSIONS, "/s/two.jsonl");
	const html = renderSelectorHtml(
		subject.getState(),
		{ columns: 100, rows: 30 },
		{
			isCurrentSession: (path) => subject.isCurrentSession(path),
		},
	);

	assert.match(html, /class="row selected" data-index="0"/);
	assert.match(html, /class="row current" data-index="1"/);
});

test("every row carries its index, which is what makes a mouse click a selection", () => {
	const subject = model();
	const html = renderSelectorHtml(subject.getState(), { columns: 100, rows: 30 });
	assert.deepEqual(
		[...html.matchAll(/data-index="(\d+)"/g)].map((match) => match[1]),
		["0", "1", "2"],
	);
});

test("a confirmation banner replaces the error banner while a delete is pending", () => {
	const subject = model(SESSIONS, "/s/one.jsonl");
	subject.select(1);
	subject.requestDelete();
	const html = renderSelectorHtml(subject.getState(), { columns: 100, rows: 30 });
	assert.match(html, /Delete \/s\/two\.jsonl\?/);
	assert.match(html, /enter to confirm, esc to cancel/);
});

test("session names are escaped, so markup in a name cannot alter the frame", () => {
	const subject = model([session("/s/x.jsonl", "<b>not bold</b>", "2026-01-01T00:00:00Z")]);
	const html = renderSelectorHtml(subject.getState(), { columns: 100, rows: 30 });
	assert.ok(!html.includes("<b>not bold</b>"));
	assert.match(html, /&lt;b&gt;not bold&lt;\/b&gt;/);
});

test("keyboard parity: the same keybindings drive the shared model", () => {
	const keybindings = KeybindingsManager.create();
	const subject = model();
	const run = {
		model: subject,
		loadCurrentSessions: async () => SESSIONS,
		loadAllSessions: async () => SESSIONS,
	};

	assert.equal(applyKey("\x1b[B", keybindings, run), undefined);
	assert.equal(subject.getState().selectedIndex, 1);
	applyKey("\x1b[A", keybindings, run);
	assert.equal(subject.getState().selectedIndex, 0);

	applyKey("\t", keybindings, run);
	assert.equal(subject.getState().scope, "all");
	applyKey("\t", keybindings, run);
	assert.equal(subject.getState().scope, "current");

	applyKey("a", keybindings, run);
	applyKey("b", keybindings, run);
	assert.equal(subject.getState().query, "ab");
	applyKey("\x7f", keybindings, run);
	assert.equal(subject.getState().query, "a");

	assert.deepEqual(applyKey("\x1b", keybindings, run), { outcome: "cancelled" });
	subject.setQuery("");
	assert.deepEqual(applyKey("\r", keybindings, run), { outcome: "selected", sessionPath: "/s/one.jsonl" });
});

test("a paste burst lands in the query rather than being read as commands", () => {
	const keybindings = KeybindingsManager.create();
	const subject = model();
	const run = { model: subject, loadCurrentSessions: async () => [], loadAllSessions: async () => [] };
	for (const character of "release prep") applyKey(character, keybindings, run);
	assert.equal(subject.getState().query, "release prep");
});

test(
	"the host attaches to an injected transport, renders, and hands the terminal back",
	async () => {
		const transport = createFakeTerminalTransport({ cols: 120, rows: 30 });
		const host = new TermDomSelectorHost({ transport });
		hosts.push(host);
		const subject = model();

		let allLoads = 0;
		const selection = host.selectSession({
			model: subject,
			loadCurrentSessions: async () => SESSIONS,
			loadAllSessions: async () => {
				allLoads += 1;
				return SESSIONS;
			},
		});
		// Let attach and the first render settle, then choose the top row.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(transport.frames.length > 0, "the picker painted something");
		assert.equal(allLoads, 0, "the cross-project scan waits for the first scope switch");
		transport.type("\t");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(allLoads, 1, "switching scope triggers exactly one load");
		transport.type("\t");
		await new Promise((resolve) => setTimeout(resolve, 30));
		transport.type("\r");

		assert.deepEqual(await selection, { outcome: "selected", sessionPath: "/s/one.jsonl" });
		await host.dispose();
		await host.dispose();
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);

test(
	"a non-interactive transport still renders instead of refusing to run",
	async () => {
		const transport = createFakeTerminalTransport({ cols: 100, rows: 30, interactive: false });
		const dom = new TermDOM({ transport });
		try {
			const subject = model();
			const frame = plain(dom.renderANSI(renderSelectorHtml(subject.getState(), { columns: 100, rows: 30 })));
			assert.match(frame, /First session/);
		} finally {
			await dom.dispose();
		}
	},
	TERMDOM_ATTACH_TIMEOUT_MS,
);
