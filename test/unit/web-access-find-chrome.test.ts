import { test } from "vitest";
import assert from "node:assert/strict";
import { findChrome } from "../../packages/web-access/find-chrome.js";

test("ORPHUS_CHROME_PATH wins when it exists", () => {
	const got = findChrome({ ORPHUS_CHROME_PATH: "/custom/chrome" } as NodeJS.ProcessEnv, (p) => p === "/custom/chrome");
	assert.equal(got, "/custom/chrome");
});

test("falls back to the first existing platform candidate", () => {
	const got = findChrome({} as NodeJS.ProcessEnv, (p) => p.includes("Google Chrome") || p.includes("chromium") || p.includes("chrome"));
	assert.ok(got && got.length > 0);
});

test("returns null when nothing is found", () => {
	assert.equal(findChrome({} as NodeJS.ProcessEnv, () => false), null);
});
