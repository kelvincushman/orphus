import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import {
	applyValidatedArguments,
	buildToolAuditRecord,
	diffPaths,
	revalidateToolArguments,
} from "../../packages/coding-agent/src/core/tool-audit.js";

const bashTool = {
	name: "bash",
	parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
};

test("post-hook arguments that no longer match the schema are rejected", () => {
	const result = revalidateToolArguments(bashTool, { command: { nested: "object" } });
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.reason : "", /failed revalidation after hooks/);
});

test("post-hook arguments that still match the schema pass through", () => {
	const result = revalidateToolArguments(bashTool, { command: "ls -la" });
	assert.equal(result.ok, true);
	assert.deepEqual(result.ok === true ? result.args : undefined, { command: "ls -la" });
});

test("a hook that deletes a required argument is caught", () => {
	const result = revalidateToolArguments(bashTool, { timeout: 5 });
	assert.equal(result.ok, false);
});

test("an unknown tool revalidates as a pass-through rather than a block", () => {
	const result = revalidateToolArguments(undefined, { anything: true });
	assert.equal(result.ok, true);
});

test("validated arguments are written back through the same reference the tool executes with", () => {
	// The agent loop holds this exact object and passes it to `tool.execute`.
	const live: Record<string, unknown> = { command: "echo hi", stale: "gone" };
	applyValidatedArguments(live, { command: "echo hi", timeout: 30 });
	assert.deepEqual(live, { command: "echo hi", timeout: 30 });
});

test("writing an object back over itself leaves it intact", () => {
	const live: Record<string, unknown> = { command: "echo hi" };
	applyValidatedArguments(live, live);
	assert.deepEqual(live, { command: "echo hi" });
});

test("diffPaths names exactly what a hook changed", () => {
	assert.deepEqual(diffPaths({ a: 1 }, { a: 1 }), []);
	assert.deepEqual(diffPaths({ command: "ls" }, { command: "rm -rf /" }), ["command"]);
	assert.deepEqual(diffPaths({ a: { b: 1 } }, { a: { b: 2 } }), ["a.b"]);
	assert.deepEqual(diffPaths({ a: 1 }, { a: 1, b: 2 }), ["b"]);
	assert.deepEqual(diffPaths({ list: [1, 2] }, { list: [1, 3] }), ["list[1]"]);
	assert.deepEqual(diffPaths({ list: [1] }, { list: [1, 2] }), ["list"]);
});

test("the audit record names the mutation and redacts credential-shaped arguments", () => {
	const record = buildToolAuditRecord({
		toolCallId: "call-1",
		toolName: "fetch",
		outcome: "executed",
		argumentsBefore: { url: "https://a.test", token: "plain" },
		argumentsAfter: { url: "https://b.test", token: "secret-value" },
		timestamp: 42,
	});
	assert.deepEqual(record.mutatedPaths.sort(), ["token", "url"]);
	assert.deepEqual(record.arguments, { url: "https://b.test", token: "[redacted]" });
	assert.equal(record.outcome, "executed");
	assert.equal(record.timestamp, 42);
});

test("a blocked call records why", () => {
	const record = buildToolAuditRecord({
		toolCallId: "call-2",
		toolName: "bash",
		outcome: "blocked",
		argumentsBefore: { command: "ls" },
		argumentsAfter: { command: "ls" },
		reason: "policy denied",
		timestamp: 1,
	});
	assert.equal(record.outcome, "blocked");
	assert.equal(record.reason, "policy denied");
	assert.deepEqual(record.mutatedPaths, []);
});
