import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import { serializeProviderBody } from "../../packages/coding-agent/src/core/provider-audit.js";
import { createReplayRuntime, type ReplayRuntime } from "../../packages/coding-agent/src/core/replay/index.js";

const running: ReplayRuntime[] = [];

afterEach(() => {
	for (const runtime of running.splice(0)) runtime.dispose();
});

async function boot(options: Parameters<typeof createReplayRuntime>[0] = {}): Promise<ReplayRuntime> {
	const runtime = await createReplayRuntime(options);
	running.push(runtime);
	return runtime;
}

const echoTool = (calls: unknown[]): ToolDefinition =>
	({
		name: "echo",
		description: "Echo a message back.",
		parameters: Type.Object({ message: Type.String() }),
		execute: async (_id: string, args: { message: string }) => {
			calls.push(args);
			return { content: [{ type: "text", text: args.message }] };
		},
	}) as unknown as ToolDefinition;

test("a scripted turn records the exact request and its response in the session", async () => {
	const runtime = await boot({ script: [{ text: "hello back" }] });

	await runtime.session.prompt("hello");

	const requests = runtime.providerRequests();
	assert.equal(requests.length, 1, "one dispatch, one request record");
	const [request] = requests;
	// The recorded body is exactly what the provider received.
	const delivered = serializeProviderBody(runtime.provider.payloads[0]);
	assert.equal(request.body, delivered);
	assert.equal(request.sha256, createHash("sha256").update(delivered, "utf8").digest("hex"));
	assert.equal(request.byteLength, Buffer.byteLength(delivered, "utf8"));
	assert.equal(request.attempt, 0);
	assert.equal(request.turn, 0);

	const responses = runtime.providerResponses();
	assert.equal(responses.length, 1);
	assert.equal(responses[0].requestId, request.requestId);
	assert.equal(responses[0].status, 200);
	assert.equal(responses[0].finishReason, "stop");
	assert.ok(responses[0].usage !== undefined);
});

test("provider records stay out of the reconstructed model context", async () => {
	const runtime = await boot({ script: [{ text: "ok" }] });
	await runtime.session.prompt("hello");

	assert.ok(runtime.providerRequests().length > 0, "the records exist");
	const contextText = JSON.stringify(runtime.session.messages);
	assert.ok(!contextText.includes("orphus.provider.request.v1"));
	assert.ok(!contextText.includes(runtime.providerRequests()[0].requestId));
});

test("every attempt before a completed response shares one turn, and each has its own record", async () => {
	const runtime = await boot({
		script: [{ error: "server overloaded", status: 529 }, { text: "recovered" }],
	});

	await runtime.session.prompt("try");

	const requests = runtime.providerRequests();
	const responses = runtime.providerResponses();
	assert.ok(requests.length >= 2, "the failure and at least one retry are each recorded");
	assert.equal(responses.length, requests.length, "every request record has a response record");
	assert.deepEqual(
		responses.map((record) => record.requestId),
		requests.map((record) => record.requestId),
		"responses correlate to requests by id, in dispatch order",
	);

	// Attempts within a turn are consecutive from zero, and the turn only advances
	// after a response that actually completed.
	const failed = requests.slice(0, -1);
	assert.deepEqual(
		failed.map((record) => [record.turn, record.attempt]),
		failed.map((_, index) => [0, index]),
	);
	assert.equal(responses[0].status, 529);
	assert.equal(responses[0].error?.kind, "overloaded");
	assert.equal(responses.at(-1)?.error, undefined);
	assert.equal(responses.at(-1)?.finishReason, "stop");
});

test("an unmodified tool call writes no audit record, because the tool call is already the record", async () => {
	const calls: unknown[] = [];
	const runtime = await boot({
		customTools: [echoTool(calls)],
		tools: ["echo"],
		script: [
			{ toolCalls: [{ id: "call-1", name: "echo", arguments: { message: "from the model" } }] },
			{ text: "done" },
		],
	});

	await runtime.session.prompt("use the tool");

	assert.deepEqual(calls, [{ message: "from the model" }], "it ran exactly what the model asked for");
	assert.deepEqual(runtime.toolAudits(), [], "no hook changed anything, so there is nothing to report");
});

test("a hook that rewrites arguments into an invalid shape blocks execution and records why", async () => {
	const calls: unknown[] = [];
	const runtime = await boot({
		customTools: [echoTool(calls)],
		tools: ["echo"],
		extensionFactories: [
			{
				name: "argument-corrupter",
				factory: (pi: {
					on: (event: string, handler: (event: { input: Record<string, unknown> }) => void) => void;
				}) => {
					pi.on("tool_call", (event) => {
						// The mutable hook contract: mutate `input` in place.
						event.input.message = { not: "a string" };
					});
				},
			},
		],
		script: [{ toolCalls: [{ id: "call-1", name: "echo", arguments: { message: "valid" } }] }, { text: "done" }],
	} as never);

	await runtime.session.prompt("use the tool");

	assert.deepEqual(calls, [], "the tool must not run with arguments its schema rejects");
	const audits = runtime.toolAudits();
	assert.equal(audits.length, 1);
	assert.equal(audits[0].outcome, "invalid_arguments");
	assert.match(audits[0].reason ?? "", /failed revalidation after hooks/);
	assert.deepEqual(audits[0].mutatedPaths, ["message"]);
});

test("a hook that rewrites arguments to a still-valid shape runs, and the audit names the change", async () => {
	const calls: unknown[] = [];
	const runtime = await boot({
		customTools: [echoTool(calls)],
		tools: ["echo"],
		extensionFactories: [
			{
				name: "argument-rewriter",
				factory: (pi: {
					on: (event: string, handler: (event: { input: Record<string, unknown> }) => void) => void;
				}) => {
					pi.on("tool_call", (event) => {
						event.input.message = "rewritten";
					});
				},
			},
		],
		script: [{ toolCalls: [{ id: "call-1", name: "echo", arguments: { message: "original" } }] }, { text: "done" }],
	} as never);

	await runtime.session.prompt("use the tool");

	assert.deepEqual(calls, [{ message: "rewritten" }], "the tool runs the post-hook arguments");
	const audits = runtime.toolAudits();
	assert.equal(audits[0].outcome, "executed");
	assert.deepEqual(audits[0].arguments, { message: "rewritten" });
	assert.deepEqual(audits[0].mutatedPaths, ["message"]);
});

test("the assembled runtime runs on the injected fake capabilities", async () => {
	const runtime = await boot({ script: [{ text: "ok" }] });
	assert.equal(runtime.session.capabilities.clock.kind, "fake");
	assert.equal(runtime.session.capabilities.fs.kind, "fake");
	assert.equal(runtime.session.capabilities.terminal.kind, "fake");

	await runtime.session.prompt("hello");
	// The fake clock never advances on its own, so every record shares its instant.
	const timestamps = new Set(runtime.providerRequests().map((record) => record.timestamp));
	assert.equal(timestamps.size, 1);
});

/** Message timestamps come from the session's own wall clock; drop them to compare shape. */
function withoutTimestamps(body: string): string {
	return body.replace(/"timestamp":\d+/g, '"timestamp":0');
}

test("two runs of the same script deliver the same request body", async () => {
	const first = await boot({ script: [{ text: "deterministic" }] });
	await first.session.prompt("same input");
	const second = await boot({ script: [{ text: "deterministic" }] });
	await second.session.prompt("same input");

	const bodyOf = (runtime: ReplayRuntime) => withoutTimestamps(runtime.providerRequests()[0].body ?? "");
	assert.equal(bodyOf(first), bodyOf(second));
});

test("a recorded body re-hashes to the hash in its own record", async () => {
	const runtime = await boot({ script: [{ text: "ok" }] });
	await runtime.session.prompt("hello");

	// Replay equivalence: the artifact is self-verifying, so a body read back
	// from a transcript can be proven to be the one that was sent.
	for (const record of runtime.providerRequests()) {
		assert.ok(record.body !== undefined, "small bodies stay inline");
		assert.equal(createHash("sha256").update(record.body, "utf8").digest("hex"), record.sha256);
		assert.equal(Buffer.byteLength(record.body, "utf8"), record.byteLength);
		assert.deepEqual(JSON.parse(record.body), runtime.provider.payloads[0]);
	}
});
