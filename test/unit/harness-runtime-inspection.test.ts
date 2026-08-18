import assert from "node:assert/strict";
import { test } from "vitest";
import { handleInspectCommand } from "../../packages/coding-agent/src/cli/inspect-runtime.js";
import { createFakeCapabilities } from "../../packages/coding-agent/src/core/capabilities/index.js";
import {
	buildRuntimeInspection,
	canonicalJson,
	formatRuntimeInspection,
	RUNTIME_INSPECTION_VERSION,
	type RuntimeInspectionInput,
	splitPromptSections,
} from "../../packages/coding-agent/src/core/runtime-inspection.js";

const SYSTEM_PROMPT = ["You are Orphus.", "", "# Project Context", "project rules", "", "# Skills", "skill list"].join(
	"\n",
);

function input(overrides: Partial<RuntimeInspectionInput> = {}): RuntimeInspectionInput {
	return {
		appVersion: "9.9.9",
		model: { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages", thinkingLevel: "high" },
		capabilities: createFakeCapabilities(),
		tools: [
			{
				name: "read",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				source: "builtin",
				active: true,
			},
			{
				name: "bash",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				source: "builtin",
				active: false,
			},
		],
		extensions: [
			{ path: "/ext/first", source: "user", handlers: new Map([["session_start", [() => {}]]]) },
			{
				path: "/ext/second",
				source: "project",
				handlers: new Map([
					["session_start", [() => {}, () => {}]],
					["tool_call", [() => {}]],
				]),
			},
		],
		flags: [{ name: "verbose", owner: "/ext/first", origin: "atomic", value: true, explicit: true }],
		globalSettings: { theme: "dark", apiKey: "sk-should-not-appear" },
		projectSettings: { theme: "light" },
		systemPrompt: SYSTEM_PROMPT,
		...overrides,
	};
}

test("the report is versioned and names every capability implementation", () => {
	const report = buildRuntimeInspection(input());
	assert.equal(report.version, RUNTIME_INSPECTION_VERSION);
	assert.equal(report.appVersion, "9.9.9");
	assert.deepEqual(report.capabilities, {
		browser: "fake",
		clock: "fake",
		credentials: "fake",
		fs: "fake",
		process: "fake",
		terminal: "fake",
		transcription: "fake",
	});
});

test("two runs of the same configuration produce byte-identical output", () => {
	assert.equal(
		formatRuntimeInspection(buildRuntimeInspection(input())),
		formatRuntimeInspection(buildRuntimeInspection(input())),
	);
});

test("tool schema hashes depend on the schema, not on key order", () => {
	const ordered = buildRuntimeInspection(
		input({
			tools: [{ name: "t", parameters: { a: 1, b: 2 }, source: "builtin", active: true }],
		}),
	);
	const shuffled = buildRuntimeInspection(
		input({
			tools: [{ name: "t", parameters: { b: 2, a: 1 }, source: "builtin", active: true }],
		}),
	);
	assert.equal(ordered.tools[0].schemaSha256, shuffled.tools[0].schemaSha256);

	const different = buildRuntimeInspection(
		input({ tools: [{ name: "t", parameters: { a: 1, b: 3 }, source: "builtin", active: true }] }),
	);
	assert.notEqual(ordered.tools[0].schemaSha256, different.tools[0].schemaSha256);
});

test("hook order follows extension load order, not alphabetical order", () => {
	const report = buildRuntimeInspection(
		input({
			extensions: [
				{ path: "/z-loads-first", source: "user", handlers: new Map([["tool_call", [() => {}]]]) },
				{ path: "/a-loads-second", source: "user", handlers: new Map([["tool_call", [() => {}]]]) },
			],
		}),
	);
	const toolCall = report.hookOrder.find((entry) => entry.event === "tool_call");
	assert.deepEqual(toolCall?.order, ["/z-loads-first", "/a-loads-second"]);
});

test("settings report which scope supplied the effective value", () => {
	const report = buildRuntimeInspection(input());
	const theme = report.settings.find((setting) => setting.key === "theme");
	assert.equal(theme?.scope, "project");
	assert.equal(theme?.value, "light");
});

test("secrets are redacted with and without --include-content", () => {
	for (const includeContent of [false, true]) {
		const report = buildRuntimeInspection(input({ includeContent }));
		const serialized = formatRuntimeInspection(report);
		assert.ok(!serialized.includes("sk-should-not-appear"), "an api key must never reach the report");
		assert.equal(report.settings.find((setting) => setting.key === "apiKey")?.value, "[redacted]");
	}
});

test("--include-content adds the prompt body, and nothing else", () => {
	const without = buildRuntimeInspection(input({ includeContent: false }));
	const with_ = buildRuntimeInspection(input({ includeContent: true }));
	assert.equal(without.systemPrompt.content, undefined);
	assert.equal(with_.systemPrompt.content, SYSTEM_PROMPT);
	assert.deepEqual(
		{ ...with_, systemPrompt: { ...with_.systemPrompt, content: undefined } },
		{ ...without, systemPrompt: { ...without.systemPrompt, content: undefined } },
	);
});

test("prompt sections are hashed individually", () => {
	const report = buildRuntimeInspection(input());
	assert.deepEqual(
		report.systemPrompt.sections.map((section) => section.heading),
		["preamble", "Project Context", "Skills"],
	);
	// A change confined to one section moves only that section's hash.
	const changed = buildRuntimeInspection(
		input({ systemPrompt: SYSTEM_PROMPT.replace("project rules", "different rules") }),
	);
	assert.equal(report.systemPrompt.sections[0].sha256, changed.systemPrompt.sections[0].sha256);
	assert.notEqual(report.systemPrompt.sections[1].sha256, changed.systemPrompt.sections[1].sha256);
	assert.equal(report.systemPrompt.sections[2].sha256, changed.systemPrompt.sections[2].sha256);
	assert.notEqual(report.systemPrompt.sha256, changed.systemPrompt.sha256);
});

test("splitPromptSections handles a prompt with no headings", () => {
	assert.deepEqual(splitPromptSections("just text"), [{ heading: "preamble", body: "just text" }]);
});

test("a shell comment inside a fenced block is not a section heading", () => {
	// The prompt carries whole context files verbatim, so this is what a README's
	// code sample looks like once it is inlined.
	const prompt = [
		"preamble text",
		"# Real Heading",
		"```sh",
		"# not a heading, a shell comment",
		"bun run scripts/cut-release.ts 0.1.0",
		"```",
		"still inside Real Heading",
		"# Another Heading",
		"~~~",
		"# also not a heading",
		"~~~",
	].join("\n");

	assert.deepEqual(
		splitPromptSections(prompt).map((section) => section.heading),
		["preamble", "Real Heading", "Another Heading"],
	);
});

test("an unterminated fence does not swallow every later heading", () => {
	const prompt = ["# One", "````", "# inside a long fence", "```", "# still inside", "````", "# Two"].join("\n");
	assert.deepEqual(
		splitPromptSections(prompt).map((section) => section.heading),
		["One", "Two"],
	);
});

test("canonicalJson sorts keys at every depth", () => {
	assert.equal(
		canonicalJson({ b: { d: 1, c: 2 }, a: [3, { f: 1, e: 2 }] }),
		'{"a":[3,{"e":2,"f":1}],"b":{"c":2,"d":1}}',
	);
});

test("`inspect` rejects an unknown subcommand without booting a runtime", async () => {
	const errors: string[] = [];
	const originalError = console.error;
	const originalExitCode = process.exitCode;
	console.error = (message: unknown) => errors.push(String(message));
	try {
		assert.equal(await handleInspectCommand(["inspect", "sideways"]), true);
		assert.equal(process.exitCode, 1);
		assert.match(errors.join("\n"), /unknown inspect subcommand/);
	} finally {
		console.error = originalError;
		process.exitCode = originalExitCode;
	}
});

test("`inspect` rejects unknown options", async () => {
	const errors: string[] = [];
	const originalError = console.error;
	const originalExitCode = process.exitCode;
	console.error = (message: unknown) => errors.push(String(message));
	try {
		assert.equal(await handleInspectCommand(["inspect", "runtime", "--secrets"]), true);
		assert.equal(process.exitCode, 1);
		assert.match(errors.join("\n"), /unknown option/);
	} finally {
		console.error = originalError;
		process.exitCode = originalExitCode;
	}
});

test("`inspect` declines argv it does not own", async () => {
	assert.equal(await handleInspectCommand(["--help"]), false);
	assert.equal(await handleInspectCommand([]), false);
});
