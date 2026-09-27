#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteSession, openSession } from "cc-session-io";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readdirSync(join(root, "src"), { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
	.map((entry) => readFileSync(join(root, "src", entry.name), "utf8"))
	.join("\n");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: () => {},
		registerTool: () => {},
	});
	return handlers;
}

describe("Orphus host contract", () => {
	it("imports only host-virtual coding-agent exports", () => {
		assert.doesNotMatch(source, /@earendil-works\/pi-coding-agent/);
		assert.match(source, /from ["']@orphus\/coding-agent["']/);
		assert.doesNotMatch(source, /import\s*\{[^}]*\bcompact\b[^}]*\}\s*from/);
	});

	it("declares Orphus core modules as host-provided peers", () => {
		assert.equal(pkg.peerDependencies?.["@orphus/coding-agent"], "*");
		assert.equal(pkg.peerDependencies?.["@earendil-works/pi-ai"], "*");
		assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], "*");
		assert.equal(pkg.peerDependencies?.typebox, "*");
		assert.equal(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"], undefined);
	});

	it("uses native Orphus compaction and rebuilds Claude context after persistence", () => {
		const handlers = activateWithMockPi();
		assert.equal(handlers.has("session_before_compact"), false,
			"the bridge must not call Pi's missing summary compactor or return Pi's old { compaction } shape");

		const cwd = mkdtempSync(join(tmpdir(), "orphus-compact-rebuild-"));
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 4, cwd });
			for (const handler of handlers.get("session_compact") ?? []) {
				handler({ result: { rung: "planned" }, fromExtension: false });
			}
			assert.equal(__test.getSharedSession()?.needsRebuild, true);

			const sync = __test.syncSharedSession([
				{ role: "user", content: "[compacted Orphus boundary]", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "retained answer" }], timestamp: 2 },
				{ role: "user", content: "next turn", timestamp: 3 },
			], cwd);
			assert.equal(sync.sessionId, sessionId, "compaction rebuilds in place instead of resuming stale history");
			const rebuilt = openSession({ sessionId, projectPath: cwd });
			assert.deepEqual(rebuilt.messages.map((message) => message.type), ["user", "assistant"]);
			assert.equal(rebuilt.messages[0].message.content, "[compacted Orphus boundary]");
			assert.equal(rebuilt.messages[1].message.content[0].text, "retained answer");
		} finally {
			__test.resetSharedSession();
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
