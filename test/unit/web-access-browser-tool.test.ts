import assert from "node:assert/strict";
import { test } from "vitest";
import { BrowserManager } from "../../packages/web-access/browser-manager.js";
import { buildBrowserExecute } from "../../packages/web-access/browser-tool.js";

test("browser tool refuses when the flag is off", async () => {
	const execute = buildBrowserExecute(new BrowserManager(), { ORPHUS_ENABLE_BROWSER: undefined } as NodeJS.ProcessEnv);
	const out = await execute({ action: "open", url: "https://example.com" });
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /ORPHUS_ENABLE_BROWSER/);
});
