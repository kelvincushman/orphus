#!/usr/bin/env node
// The branch-summarization takeover, end to end against a real Claude Code subprocess.
//
// pi runs branch summaries through the *agent's* stream function, so on a bridge model
// they reach this provider carrying pi's internal summarization prompt — one no
// `before_agent_start` ever recorded. `session_before_tree` takes that over and runs it
// as an isolated subprocess instead. The unit tests cover the decision to take over and
// the shape of the result; only this exercises the summary actually being produced.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

const harness = createRpcHarness({
	name: "branch-summary",
	args: [
		"-e", "./tests/fixtures/tree-nav-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("branch summarization takeover", () => {
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => { await stop(); });

	/** The command returns before the summary finishes, and a slash command emits no
	 *  agent_end, so wait on the log the takeover writes. */
	async function waitForLog(mark, pattern, timeout = 90_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const slice = readFileSync(DEBUG_LOG, "utf8").slice(mark);
			if (pattern.test(slice)) return slice;
			await sleep(500);
		}
		return readFileSync(DEBUG_LOG, "utf8").slice(mark);
	}

	it("summarizes an abandoned branch without routing through the live provider", { timeout: TEST_TIMEOUT }, async () => {
		// Two turns so rewinding to the first leaves something worth summarizing.
		await promptAndWait("Reply with exactly the word ALPHA and nothing else.");
		await promptAndWait("Reply with exactly the word BETA and nothing else.");

		const mark = statSync(DEBUG_LOG).size;
		await send({ type: "prompt", message: "/rewind-summarize" });

		const log = await waitForLog(mark, /session_before_tree: takeover complete/);

		assert.match(log, /session_before_tree: takeover entries=\d+/, `takeover never fired:\n${log.slice(-1500)}`);
		assert.match(
			log,
			/session_before_tree: takeover complete summaryLen=[1-9]\d*/,
			`takeover produced no summary:\n${log.slice(-1500)}`,
		);
		// The whole point: it ran as its own subprocess, so the resolver that would
		// have refused pi's summarization prompt was never consulted.
		assert.doesNotMatch(log, /no capture for this \d+-char system prompt/, "the summary reached the provider path");
	});
});
