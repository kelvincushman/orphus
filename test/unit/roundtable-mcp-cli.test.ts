import assert from "node:assert/strict";
import { test } from "vitest";
import { parseBridgeArgs } from "../../packages/roundtable/mcp/cli.js";

test("requires --as with a value", () => {
	assert.deepEqual("error" in parseBridgeArgs([]), true);
	assert.deepEqual("error" in parseBridgeArgs(["--as"]), true);
});

test("accepts a well-formed role", () => {
	assert.deepEqual(parseBridgeArgs(["--as", "critic"]), { role: "critic" });
	assert.deepEqual(parseBridgeArgs(["--as", "code-reviewer_2"]), { role: "code-reviewer_2" });
});

test("rejects a role the manifest would reject — cursors are keyed by it", () => {
	for (const bad of ["has space", "", "  ", "-leading", "naïve"]) {
		const parsed = parseBridgeArgs(["--as", bad]);
		assert.ok("error" in parsed, `expected rejection for ${JSON.stringify(bad)}`);
	}
});
