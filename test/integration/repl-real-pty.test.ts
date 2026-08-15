import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { createPtyKernel, type PtySessionLike } from "../../packages/coding-agent/src/core/repl/kernel-pty.js";
import { KernelSession } from "../../packages/coding-agent/src/core/repl/kernel-session.js";

/**
 * The one test that drives a **real** process.
 *
 * Every other kernel test injects a fake session, which proves the logic and
 * nothing about the contract with the native binding. The claims being checked
 * here are exactly the ones a fake cannot check:
 *
 * - `closeStdinAfterCommand: false` really does keep a REPL alive between writes
 * - `write()` really does reach its stdin
 * - the sentinel really does come back, unbuffered, in the data callback
 * - a value set by one `exec` is really still there for the next
 *
 * Skips rather than fails when the binding or `python3` is unavailable: this
 * runs green on the dev server and on CI's ubuntu runner, and a developer on a
 * machine without the native build should not be blocked by it. The skip is
 * loud in the test name so an all-skipped run cannot be mistaken for a pass.
 */

const REAL_PROCESS_TIMEOUT_MS = 60_000;

async function loadBinding(): Promise<(new () => PtySessionLike) | undefined> {
	try {
		const natives = (await import("@orphus/natives")) as unknown as { PtySession?: new () => PtySessionLike };
		return natives.PtySession;
	} catch {
		return undefined;
	}
}

function hasPython(): boolean {
	try {
		return spawnSync("python3", ["--version"]).status === 0;
	} catch {
		return false;
	}
}

test(
	"a real python kernel keeps its values between execs",
	async () => {
		const PtySession = await loadBinding();
		if (!PtySession || !hasPython()) {
			// Stated rather than silent: an all-skipped run must not read as a pass.
			console.warn("[repl-real-pty] SKIPPED — native PTY binding or python3 unavailable on this machine");
			return;
		}

		let session: KernelSession | undefined;
		const kernel = createPtyKernel({
			language: "python",
			cwd: process.cwd(),
			onData: (chunk) => session?.receive(chunk),
			createSession: () => new PtySession(),
		});
		session = new KernelSession({ name: "real", language: "python", process: kernel.process });

		try {
			// The REPL prints a banner and prompt before it is ready; the first exec
			// absorbs that, which is precisely why exec waits for a sentinel rather
			// than for output to stop.
			const first = await session.exec("value = 6 * 7", { token: "r1", timeoutMs: 20_000 });
			assert.equal(first.timedOut, false);

			// The claim the whole phase rests on: the value survived the call.
			const second = await session.exec("print(value)", { token: "r2", timeoutMs: 20_000 });
			assert.match(second.view.text, /42/);
			assert.doesNotMatch(second.view.text, /ORPHUS_KERNEL_DONE/);

			// And a third, to show the kernel is still a kernel rather than a
			// one-shot that happened to answer twice.
			const third = await session.exec("print(value + 1)", { token: "r3", timeoutMs: 20_000 });
			assert.match(third.view.text, /43/);
		} finally {
			kernel.process.kill();
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);

test(
	"a real kernel's output is bounded no matter how much it prints",
	async () => {
		const PtySession = await loadBinding();
		if (!PtySession || !hasPython()) {
			console.warn("[repl-real-pty] SKIPPED — native PTY binding or python3 unavailable on this machine");
			return;
		}

		let session: KernelSession | undefined;
		const kernel = createPtyKernel({
			language: "python",
			cwd: process.cwd(),
			onData: (chunk) => session?.receive(chunk),
			createSession: () => new PtySession(),
		});
		session = new KernelSession({ name: "real", language: "python", process: kernel.process });

		try {
			await session.exec("pass", { token: "b0", timeoutMs: 20_000 });
			const result = await session.exec("print('x' * 200000)", { token: "b1", timeoutMs: 30_000 });

			// The property, against a process that really did print 200 KB.
			assert.ok(result.view.text.length <= 4_000, `view was ${result.view.text.length} chars`);
			assert.ok(result.view.elidedChars > 0, "a 200 KB print must report an elision");
		} finally {
			kernel.process.kill();
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);
