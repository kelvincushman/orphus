import assert from "node:assert/strict";
import { test } from "vitest";
import { BrowserManager } from "../../packages/web-access/browser-manager.js";
import { buildBrowserExecute } from "../../packages/web-access/browser-tool.js";
import { installBunGlobal } from "../helpers/runtime.js";

// wait_for's poll loop calls Bun.sleep between attempts (browser-tool.ts only ever runs inside
// the Bun-compiled binary, same convention as browser-manager.ts and subprocess.ts), so the
// polling regression test below needs the Bun global under vitest's Node environment.
installBunGlobal();

test("browser tool refuses when the flag is off", async () => {
	const execute = buildBrowserExecute(new BrowserManager(), { ORPHUS_ENABLE_BROWSER: undefined } as NodeJS.ProcessEnv);
	const out = await execute({ action: "open", url: "https://example.com" });
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /ORPHUS_ENABLE_BROWSER/);
});

test("failed actions mark details.error so the tool_result hook can flag them", async () => {
	// pi's agent loop hardcodes isError:false for any resolved execute() result, so the model-facing
	// error signal has to travel through details, not the isError field on the raw return value.
	const execute = buildBrowserExecute(new BrowserManager(), { ORPHUS_ENABLE_BROWSER: "1" } as NodeJS.ProcessEnv);
	const out = await execute({ action: "read" }); // no browser open under the default handle name
	assert.equal(out.isError, true);
	assert.equal(out.details.error, true);
});

test("wait_for polls the selector and resolves once it appears", async () => {
	let calls = 0;
	const send = async (method: string) => {
		if (method === "Runtime.evaluate") {
			calls += 1;
			return { result: { value: calls >= 2 } }; // absent on the first poll, present on the second
		}
		return {};
	};
	const fakeManager = { get: () => ({ cdp: { send } }) } as unknown as BrowserManager;
	const execute = buildBrowserExecute(fakeManager, { ORPHUS_ENABLE_BROWSER: "1" } as NodeJS.ProcessEnv);
	const out = await execute({ action: "wait_for", selector: "#done" });
	assert.equal(out.isError, undefined);
	assert.match(out.content[0].text, /#done appeared/);
	assert.equal(calls, 2);
});
