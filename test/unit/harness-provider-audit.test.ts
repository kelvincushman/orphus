import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "vitest";
import { createFakeClock, createFakeFileSystem } from "../../packages/coding-agent/src/core/capabilities/index.js";
import {
	isProviderAuditEnabled,
	MAX_INLINE_BODY_BYTES,
	normalizeProviderError,
	PROVIDER_REQUEST_ENTRY,
	PROVIDER_REQUEST_SPILL_DIR,
	PROVIDER_RESPONSE_ENTRY,
	ProviderAuditRecorder,
	REDACTED,
	redactCredentialFields,
	serializeProviderBody,
} from "../../packages/coding-agent/src/core/provider-audit.js";

interface Appended {
	customType: string;
	data: unknown;
}

function createSink(options?: { sessionDir?: string | null; leafId?: string | null }) {
	const appended: Appended[] = [];
	return {
		appended,
		sink: {
			appendCustomEntry: (customType: string, data?: unknown) => {
				appended.push({ customType, data });
				return `entry-${appended.length}`;
			},
			getSessionDir: () => (options && "sessionDir" in options ? options.sessionDir : "/sessions/abc") ?? null,
			getLeafId: () => (options && "leafId" in options ? options.leafId : "leaf-1") ?? null,
		},
	};
}

function createRecorder(overrides?: {
	sessionDir?: string | null;
	fs?: ReturnType<typeof createFakeFileSystem>;
	enabled?: boolean;
}) {
	const { appended, sink } = createSink(
		overrides && "sessionDir" in overrides ? { sessionDir: overrides.sessionDir } : {},
	);
	const fs = overrides?.fs ?? createFakeFileSystem();
	const clock = createFakeClock();
	let counter = 0;
	const recorder = new ProviderAuditRecorder({
		session: sink,
		fs,
		clock,
		newRequestId: () => `req-${++counter}`,
		enabled: overrides?.enabled,
	});
	return { recorder, appended, fs, clock };
}

test("records the exact body delivered to the provider, with its hash and byte length", async () => {
	const { recorder, appended } = createRecorder();
	const payload = { model: "m", messages: [{ role: "user", content: "hi" }] };

	await recorder.recordRequest({ payload, provider: "anthropic", model: "m", api: "anthropic-messages" });

	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, PROVIDER_REQUEST_ENTRY);
	const record = appended[0].data as Record<string, unknown>;
	const body = serializeProviderBody(payload);
	assert.equal(record.body, body);
	assert.equal(record.byteLength, Buffer.byteLength(body, "utf8"));
	assert.equal(record.sha256, createHash("sha256").update(body, "utf8").digest("hex"));
	assert.equal(record.provider, "anthropic");
	assert.equal(record.api, "anthropic-messages");
	assert.equal(record.branchLeafId, "leaf-1");
	assert.equal(record.attempt, 0);
	assert.equal(record.turn, 0);
});

test("spills a body over 1 MiB to an owner-only artifact referenced by relative path", async () => {
	const fs = createFakeFileSystem();
	const { recorder, appended } = createRecorder({ fs });
	const payload = { blob: "x".repeat(MAX_INLINE_BODY_BYTES + 10) };

	await recorder.recordRequest({ payload, provider: "p", model: "m", api: "a" });

	const record = appended[0].data as Record<string, unknown>;
	assert.equal(record.body, undefined);
	assert.equal(record.bodyPath, `${PROVIDER_REQUEST_SPILL_DIR}/req-1.json`);
	const written = fs.files.get(join("/sessions/abc", `${PROVIDER_REQUEST_SPILL_DIR}/req-1.json`));
	assert.ok(written, "expected the spilled body on disk");
	assert.equal(written.mode, 0o600);
	assert.equal(written.data, serializeProviderBody(payload));
	// The hash still describes the exact body, so the artifact is verifiable.
	assert.equal(record.sha256, createHash("sha256").update(written.data, "utf8").digest("hex"));
	assert.equal(record.byteLength, Buffer.byteLength(written.data, "utf8"));
});

test("fails the attempt before dispatch when the spill cannot be written", async () => {
	const fs = createFakeFileSystem();
	fs.failWrites(() => true, new Error("EACCES: denied"));
	const { recorder, appended } = createRecorder({ fs });

	await assert.rejects(
		() =>
			recorder.recordRequest({
				payload: { blob: "x".repeat(MAX_INLINE_BODY_BYTES + 10) },
				provider: "p",
				model: "m",
				api: "a",
			}),
		/EACCES/,
	);
	assert.equal(appended.length, 0, "a failed record must not leave a half-written entry behind");
});

test("fails the attempt when an oversized body has nowhere to spill", async () => {
	const { recorder } = createRecorder({ sessionDir: null });
	await assert.rejects(
		() =>
			recorder.recordRequest({
				payload: { blob: "x".repeat(MAX_INLINE_BODY_BYTES + 10) },
				provider: "p",
				model: "m",
				api: "a",
			}),
		/no directory to spill into/,
	);
});

test("correlates retries within a turn and opens a new turn after a completed response", async () => {
	const { recorder, appended } = createRecorder();
	const dispatch = () => recorder.recordRequest({ payload: {}, provider: "p", model: "m", api: "a" });

	await dispatch();
	recorder.recordResponse({ finishReason: "error", error: new Error("overloaded") });
	await dispatch();
	recorder.recordResponse({ finishReason: "stop", usage: { input: 1 } });
	await dispatch();
	recorder.recordResponse({ finishReason: "stop" });

	const requests = appended.filter((entry) => entry.customType === PROVIDER_REQUEST_ENTRY).map((e) => e.data as never);
	assert.deepEqual(
		requests.map((record: { turn: number; attempt: number }) => [record.turn, record.attempt]),
		[
			[0, 0],
			[0, 1],
			[1, 0],
		],
	);

	const responses = appended
		.filter((entry) => entry.customType === PROVIDER_RESPONSE_ENTRY)
		.map((entry) => entry.data as { requestId: string; turn: number; attempt: number; error?: { kind: string } });
	assert.deepEqual(
		responses.map((record) => record.requestId),
		["req-1", "req-2", "req-3"],
	);
	assert.equal(responses[0].error?.kind, "overloaded");
	assert.equal(responses[1].error, undefined);
});

test("response records carry status, finish reason, usage, and duration", async () => {
	const { recorder, appended, clock } = createRecorder();
	await recorder.recordRequest({ payload: {}, provider: "p", model: "m", api: "a" });
	recorder.noteResponseStatus(200);
	await clock.advance(1234);
	recorder.recordResponse({ finishReason: "toolUse", usage: { input: 7, output: 9 } });

	const response = appended.at(-1)?.data as Record<string, unknown>;
	assert.equal(appended.at(-1)?.customType, PROVIDER_RESPONSE_ENTRY);
	assert.equal(response.status, 200);
	assert.equal(response.finishReason, "toolUse");
	assert.deepEqual(response.usage, { input: 7, output: 9 });
	assert.equal(response.durationMs, 1234);
});

test("redacts credential-shaped payload fields while hashing the exact body", async () => {
	const { recorder, appended } = createRecorder();
	const payload = { model: "m", apiKey: "sk-secret", nested: { authorization: "Bearer t", keep: "visible" } };

	await recorder.recordRequest({ payload, provider: "p", model: "m", api: "a" });

	const record = appended[0].data as { body: string; sha256: string; redactedPaths: string[] };
	assert.ok(!record.body.includes("sk-secret"));
	assert.ok(!record.body.includes("Bearer t"));
	assert.ok(record.body.includes("visible"));
	assert.deepEqual(record.redactedPaths.sort(), ["apiKey", "nested.authorization"]);
	// The hash still describes what was actually sent, not the redacted copy.
	assert.equal(record.sha256, createHash("sha256").update(serializeProviderBody(payload), "utf8").digest("hex"));
});

test("redactCredentialFields leaves ordinary values untouched", () => {
	const { value, redactedPaths } = redactCredentialFields({ token: "t", tokens: ["a"], tokenizer: "keep", n: 1 });
	assert.deepEqual(value, { token: REDACTED, tokens: ["a"], tokenizer: "keep", n: 1 });
	assert.deepEqual(redactedPaths, ["token"]);
});

test("records nothing when recording is disabled, but still returns a request id", async () => {
	const { recorder, appended } = createRecorder({ enabled: false });
	const requestId = await recorder.recordRequest({ payload: {}, provider: "p", model: "m", api: "a" });
	recorder.recordResponse({ finishReason: "stop" });
	assert.ok(requestId.length > 0);
	assert.deepEqual(appended, []);
});

test("the recording switch is on unless explicitly disabled", () => {
	assert.equal(isProviderAuditEnabled({}), true);
	assert.equal(isProviderAuditEnabled({ ORPHUS_PROVIDER_AUDIT: "1" }), true);
	assert.equal(isProviderAuditEnabled({ ORPHUS_PROVIDER_AUDIT: "0" }), false);
	assert.equal(isProviderAuditEnabled({ ORPHUS_PROVIDER_AUDIT: "off" }), false);
});

test("normalizes provider failures onto a small vocabulary", () => {
	assert.equal(normalizeProviderError(new Error("boom"), 401).kind, "auth");
	assert.equal(normalizeProviderError(new Error("Rate limit exceeded")).kind, "rate_limit");
	assert.equal(normalizeProviderError(new Error("server overloaded")).kind, "overloaded");
	assert.equal(normalizeProviderError(new Error("maximum context length")).kind, "context_overflow");
	assert.equal(normalizeProviderError(new Error("fetch failed")).kind, "network");
	assert.equal(normalizeProviderError(new Error("operation aborted")).kind, "aborted");
	assert.equal(normalizeProviderError(new Error("bad request"), 400).kind, "provider");
	assert.equal(normalizeProviderError("something else").kind, "unknown");
});
