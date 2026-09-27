#!/usr/bin/env node

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

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

describe("Orphus branch summarization", () => {
	afterEach(() => __test.resetSharedSession());

	it("leaves branch summary generation to the host provider path", () => {
		const handlers = activateWithMockPi();
		assert.equal(handlers.has("session_before_tree"), false,
			"Orphus's native summary call uses the registered provider and its cacheRetention:none isolation path");
	});

	it("rebuilds Claude context after tree navigation", () => {
		const handlers = activateWithMockPi();
		__test.setSharedSession({
			sessionId: "11111111-1111-4111-8111-111111111111",
			cursor: 4,
			cwd: process.cwd(),
		});
		for (const handler of handlers.get("session_tree") ?? []) handler({});
		assert.equal(__test.getSharedSession()?.needsRebuild, true);
	});
});
