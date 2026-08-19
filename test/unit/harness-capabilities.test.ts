import assert from "node:assert/strict";
import { test } from "vitest";
import { createFakeProcesses, nodeProcesses } from "../../packages/coding-agent/src/core/capabilities/index.js";

/**
 * `exec` must resolve on "close", not "exit": a child can exit while something
 * it started still holds its stdout pipe. This child exits immediately after
 * handing its stdout to a grandchild that writes 80ms later — resolving on
 * "exit" loses that trailing output every time.
 */
test("exec captures output written after the child exits but before its pipes close", async () => {
	const script = [
		"const { spawn } = require('node:child_process');",
		"spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('late'), 80)\"],",
		"  { stdio: ['ignore', 'inherit', 'ignore'] });",
		"process.stdout.write('early;');",
	].join("\n");
	const result = await nodeProcesses.exec(process.execPath, ["-e", script]);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "early;late");
});

test("exec reports a missing binary as a settled failure, not a crash", async () => {
	const result = await nodeProcesses.exec("/no/such/binary-orphus-test", []);
	assert.equal(result.code, null);
	assert.match(result.stderr, /ENOENT/);
});

test("killing an already-settled fake process cannot drive `alive` below zero", () => {
	const processes = createFakeProcesses();
	processes.script("chrome", { exit: { code: 0, signal: null } });
	const handle = processes.spawn("chrome", []);
	assert.equal(processes.alive, 0, "the scripted exit settled the process at spawn");

	// The cleanup path a session runs unconditionally.
	handle.kill("SIGTERM");
	handle.kill("SIGKILL");
	assert.equal(processes.alive, 0, "settlement is idempotent");
});
