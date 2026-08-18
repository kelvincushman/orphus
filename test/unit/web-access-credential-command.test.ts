import assert from "node:assert/strict";
import { test } from "vitest";
import { parseCredentialCommand } from "../../packages/web-access/credential-command.js";

test("parses add with exactly domain, label, username", () => {
	const parsed = parseCredentialCommand("add example.com main me@example.com");
	assert.deepEqual(parsed, { op: "add", domain: "example.com", label: "main", username: "me@example.com" });
});

test("rejects a 4th token on add so a secret can never travel as a command argument", () => {
	const parsed = parseCredentialCommand("add example.com main me@example.com hunter2");
	assert.ok("error" in parsed, "a 4th token must be rejected as a parse error");
	if ("error" in parsed) {
		assert.match(parsed.error, /secret/i);
		assert.ok(!parsed.error.includes("hunter2"), "the rejected token must not be echoed back in the error");
	}
});

test("parses remove with domain and label", () => {
	const parsed = parseCredentialCommand("remove example.com main");
	assert.deepEqual(parsed, { op: "remove", domain: "example.com", label: "main" });
});

test("parses bare list", () => {
	assert.deepEqual(parseCredentialCommand(""), { op: "list" });
	assert.deepEqual(parseCredentialCommand("list"), { op: "list" });
});

test("rejects list with extra arguments", () => {
	assert.ok("error" in parseCredentialCommand("list example.com"));
});

test("rejects add with too few arguments", () => {
	assert.ok("error" in parseCredentialCommand("add example.com main"));
});

test("rejects remove with too few arguments", () => {
	assert.ok("error" in parseCredentialCommand("remove example.com"));
});

test("rejects an unknown subcommand", () => {
	const parsed = parseCredentialCommand("wipe example.com");
	assert.ok("error" in parsed);
});
