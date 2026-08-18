import assert from "node:assert/strict";
import { test } from "vitest";
import { parseCredentialCommand } from "../../packages/web-access/credential-command.js";

test("parses add with exactly domain, label, username", () => {
	const parsed = parseCredentialCommand("add example.com main me@example.com");
	assert.deepEqual(parsed, { kind: "add", domain: "example.com", label: "main", username: "me@example.com" });
});

test("rejects a 4th token on add so a secret can never travel as a command argument", () => {
	const parsed = parseCredentialCommand("add example.com main me@example.com hunter2");
	assert.equal(parsed.kind, "error");
	assert.ok(!JSON.stringify(parsed).includes("hunter2"), "the rejected token must not be echoed back in the error");
});

test("parses remove with domain and label", () => {
	const parsed = parseCredentialCommand("remove example.com main");
	assert.deepEqual(parsed, { kind: "remove", domain: "example.com", label: "main" });
});

test("parses bare list", () => {
	assert.deepEqual(parseCredentialCommand(""), { kind: "list" });
	assert.deepEqual(parseCredentialCommand("list"), { kind: "list" });
});

test("rejects list with extra arguments", () => {
	assert.equal(parseCredentialCommand("list example.com").kind, "error");
});

test("rejects add with too few arguments", () => {
	assert.equal(parseCredentialCommand("add example.com main").kind, "error");
});

test("rejects remove with too few arguments", () => {
	assert.equal(parseCredentialCommand("remove example.com").kind, "error");
});

test("rejects an unknown subcommand", () => {
	const parsed = parseCredentialCommand("wipe example.com");
	assert.equal(parsed.kind, "error");
});
