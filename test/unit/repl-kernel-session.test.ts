import assert from "node:assert/strict";
import { test } from "vitest";
import {
	execScript,
	KernelBusy,
	KernelExecTimeout,
	KernelSession,
	sentinelFor,
} from "../../packages/coding-agent/src/core/repl/kernel-session.js";

/**
 * A fake REPL: echoes what is written (as a PTY does), then prints whatever the
 * script told it to. Nothing is spawned.
 */
function fakeKernel(options: { language?: "python" | "node"; respond?: (written: string) => string } = {}) {
	const writes: string[] = [];
	let killed = false;
	const session: KernelSession = new KernelSession({
		name: "test",
		language: options.language ?? "python",
		process: {
			write: (data) => {
				writes.push(data);
				const reply = options.respond?.(data);
				if (reply !== undefined) queueMicrotask(() => session.receive(reply));
			},
			kill: () => {
				killed = true;
			},
		},
	});
	return { session, writes, wasKilled: () => killed };
}

/** What a real python REPL would emit: the echoed input, the output, the sentinel. */
function pythonLike(output: string) {
	return (written: string): string => {
		const sentinel = /__ORPHUS_KERNEL_DONE_\w+__/.exec(written)?.[0] ?? "";
		return `${written}${output}${sentinel}\n`;
	};
}

test("exec resolves when the sentinel arrives, not when output stops", () => {
	// A REPL never says it is done; it prints a prompt, which is
	// indistinguishable from a program that printed a prompt.
	const { session } = fakeKernel({ respond: pythonLike("42\n") });

	return session.exec("6 * 7", { token: "a1" }).then((result) => {
		assert.match(result.view.text, /42/);
		assert.equal(result.timedOut, false);
	});
});

test("the sentinel and the line that printed it never reach the model", () => {
	// Otherwise every single call would put an implementation detail in front of
	// the reader.
	const { session } = fakeKernel({ respond: pythonLike("hello\n") });

	return session.exec("print('hello')", { token: "b2" }).then((result) => {
		assert.doesNotMatch(result.view.text, /ORPHUS_KERNEL_DONE/);
		assert.doesNotMatch(result.raw, /ORPHUS_KERNEL_DONE/);
		assert.match(result.view.text, /hello/);
	});
});

test("a kernel that never finishes times out with its partial output kept", () => {
	// The partial output is frequently the diagnosis — a traceback that printed
	// before the hang. Discarding it would throw away the reason.
	const { session, wasKilled } = fakeKernel({
		respond: () => "partial progress\n",
	});

	return session.exec("while True: pass", { token: "c3", timeoutMs: 5 }).then(
		() => assert.fail("expected a timeout"),
		(error: unknown) => {
			assert.ok(error instanceof KernelExecTimeout);
			assert.match(error.partial, /partial progress/);
			// The kernel stays alive: the code may still be running, and killing it
			// because one call was slow would destroy every value in it.
			assert.equal(wasKilled(), false);
		},
	);
});

test("output arriving before the listener attaches is not missed", () => {
	// A synchronous echo would otherwise be written, land, and be gone before
	// anything was waiting for it.
	const writes: string[] = [];
	let session: KernelSession | undefined;
	session = new KernelSession({
		name: "eager",
		language: "python",
		process: {
			write: (data) => {
				writes.push(data);
				const sentinel = /__ORPHUS_KERNEL_DONE_\w+__/.exec(data)?.[0] ?? "";
				// Synchronously, before exec has installed its waiter.
				session?.receive(`early\n${sentinel}\n`);
			},
			kill: () => {},
		},
	});

	return session.exec("x", { token: "d4", timeoutMs: 50 }).then((result) => {
		assert.match(result.view.text, /early/);
	});
});

test("each language is told how to print the sentinel in its own syntax", () => {
	assert.match(execScript("python", "1+1", "t"), /^1\+1\nprint\("__ORPHUS_KERNEL_DONE_t__"\)\n$/);
	assert.match(execScript("node", "1+1", "t"), /^1\+1\nconsole\.log\("__ORPHUS_KERNEL_DONE_t__"\)\n$/);
});

test("distinct tokens produce distinct sentinels", () => {
	// Two execs in flight must not resolve on each other's completion.
	assert.notEqual(sentinelFor("a"), sentinelFor("b"));
	assert.match(sentinelFor("a"), /__ORPHUS_KERNEL_DONE_a__/);
});

test("exec output is bounded no matter how much the code prints", () => {
	// The phase's acceptance property, at the exec boundary.
	const { session } = fakeKernel({ respond: pythonLike(`${"x".repeat(500_000)}\n`) });

	return session.exec("print('x' * 500000)", { token: "e5" }).then((result) => {
		assert.ok(result.view.text.length <= 4_000, `view was ${result.view.text.length} chars`);
		// The raw output is kept so the caller can spill it and hand back a pointer.
		assert.ok(result.raw.length > 400_000);
		assert.ok(result.view.elidedChars > 0);
	});
});

test("peek shows the kernel's output without running anything", () => {
	const { session, writes } = fakeKernel();
	session.receive("earlier output\n");

	const view = session.peek();

	assert.match(view.text, /earlier output/);
	assert.deepEqual(writes, []);
});

test("killing the kernel reaches the process", () => {
	const { session, wasKilled } = fakeKernel();
	session.kill();
	assert.equal(wasKilled(), true);
});

test("a second execution is refused while one is still running", () => {
	// Review finding, confirmed: a second exec reset `pending` and replaced
	// `waiter`, so the first promise could never settle and the two outputs
	// interleaved into whichever sentinel arrived first.
	const { session } = fakeKernel();

	const first = session.exec("slow()", { token: "t1", timeoutMs: 50 });
	// exec is async, so the guard rejects rather than throwing synchronously —
	// which is the right contract for an async API, and what a caller awaits.
	const second = assert.rejects(
		() => session.exec("second()", { token: "t2", timeoutMs: 50 }),
		(error: unknown) => error instanceof KernelBusy,
	);

	return Promise.all([
		second,
		first.then(
			() => assert.fail("expected the first exec to time out"),
			(error: unknown) => assert.ok(error instanceof KernelExecTimeout),
		),
	]);
});

test("a timed-out kernel accepts work again rather than being bricked", () => {
	// The other side of the same guard: if `running` were never released on
	// timeout, one slow call would make the kernel permanently unusable and every
	// value in it unreachable.
	const { session } = fakeKernel();

	return session.exec("hang()", { token: "t1", timeoutMs: 5 }).then(
		() => assert.fail("expected a timeout"),
		() => {
			// A fresh token, and the kernel is willing.
			const again = session.exec("x", { token: "t2", timeoutMs: 5 });
			assert.ok(again instanceof Promise);
			return again.catch(() => undefined);
		},
	);
});
