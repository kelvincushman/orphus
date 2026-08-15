import assert from "node:assert/strict";
import { test } from "vitest";
import {
	execScript,
	KernelBusy,
	KernelExecTimeout,
	KernelSession,
	SENTINEL_MARKER,
	sentinelFor,
} from "../../packages/coding-agent/src/core/repl/kernel-session.js";

/**
 * What a real interpreter does with the emitted script: echo the input, then
 * print the *evaluated* concatenation. Extracting the sentinel with a regex over
 * the raw script would be the unrealistic shortcut that hid the echo bug.
 */
function evaluateSentinel(written: string): string {
	const halves = /"([^"]*)" \+ "([^"]*)"/.exec(written);
	return halves ? `${halves[1]}${halves[2]}` : "";
}

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
		return `${written}${output}${evaluateSentinel(written)}\n`;
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
		// Assert on the MARKER, not the joined sentinel. The echoed print statement
		// carries the sentinel in split halves, so it never contains the joined
		// form — an assertion on /ORPHUS_KERNEL_DONE/ passes while the echo leaks,
		// which is exactly what happened until a real kernel showed it.
		assert.doesNotMatch(result.view.text, /__ORPHUS_KERNEL_/);
		assert.doesNotMatch(result.raw, /__ORPHUS_KERNEL_/);
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
				// Synchronously, before exec has installed its waiter.
				session?.receive(`early\n${evaluateSentinel(data)}\n`);
			},
			kill: () => {},
		},
	});

	return session.exec("x", { token: "d4", timeoutMs: 50 }).then((result) => {
		assert.match(result.view.text, /early/);
	});
});

test("the written script never contains the whole sentinel", () => {
	// The bug the real-PTY test found: a terminal echoes its input, so a script
	// carrying the literal sentinel satisfies the completion check the moment it
	// is echoed — before the code has run. Emitting it in halves means only real
	// OUTPUT can match.
	for (const language of ["python", "node"] as const) {
		const script = execScript(language, "1+1", "t");
		assert.ok(!script.includes(sentinelFor("t")), `${language} script leaked the whole sentinel`);
		assert.match(script, /^1\+1\n/);
		// The split is pinned after the marker so the echo filter has something
		// stable to match for every token length.
		assert.match(script, /"__ORPHUS_KERNEL_" \+ "DONE_t__"/);
	}
	assert.match(execScript("python", "1+1", "t"), /print\(/);
	assert.match(execScript("node", "1+1", "t"), /console\.log\(/);
});

test("the halves still concatenate to exactly the sentinel", () => {
	// If they did not, exec would wait forever for a string nothing prints.
	const script = execScript("python", "x", "tok");
	const halves = /"([^"]*)" \+ "([^"]*)"/.exec(script);
	assert.ok(halves, "expected two quoted halves");
	assert.equal(`${halves[1]}${halves[2]}`, sentinelFor("tok"));
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
			// The second call must fail its OWN way — reaching its timeout — not be
			// turned away as busy. exec is async, so it returns a Promise either way;
			// only the rejection type distinguishes "accepted and timed out" from
			// "refused because `running` was never released".
			return assert.rejects(
				() => session.exec("x", { token: "t2", timeoutMs: 5 }),
				(error: unknown) => error instanceof KernelExecTimeout && !(error instanceof KernelBusy),
			);
		},
	);
});

test("a leftover prompt fragment before the echo does not defeat stripping", () => {
	// Found by running the integration suite under load rather than standalone:
	// the previous exec's trailing prompt arrives as its own fragment, and
	// requiring the echo at position zero left the echoed source in the answer.
	let session: KernelSession | undefined;
	session = new KernelSession({
		name: "fragmented",
		language: "python",
		process: {
			write: (data: string) => {
				queueMicrotask(() => {
					// A bare prompt remnant, THEN the echo, then the answer.
					session?.receive(`\n${data}43\n${evaluateSentinel(data)}\n`);
				});
			},
			kill: () => {},
		},
	});

	return session.exec("print(value + 1)", { token: "f1", timeoutMs: 500 }).then((result) => {
		assert.equal(result.view.text.trim(), "43");
	});
});

test("the echoed sentinel print is stripped, whatever the token length", () => {
	// The split is pinned to the marker so this holds for every token; a midpoint
	// split moved with the token and left nothing stable to match.
	for (const token of ["a", "abc", "msuhf8b73", "x".repeat(40)]) {
		const script = execScript("python", "len(rows)", token);
		const echoedPrint = script.split("\n")[1] ?? "";

		assert.ok(echoedPrint.includes(SENTINEL_MARKER), `token ${token}: marker missing from the echo`);
		// And the echo must NOT contain the joined sentinel, or echoing it would
		// satisfy the completion check before the code had run.
		assert.ok(!echoedPrint.includes(sentinelFor(token)), `token ${token}: echo would complete the exec early`);
	}
});

test("the doubled echo a real kernel produces on its first exec is stripped", () => {
	// Not invented: this is the exact stream captured from a live python kernel.
	// The PTY line discipline echoes the whole script, THEN the interpreter echoes
	// it again with prompts. Matching the block once left the second copy of the
	// code in the answer — which is what shipped until a real kernel showed it.
	let session: KernelSession | undefined;
	session = new KernelSession({
		name: "doubled",
		language: "python",
		process: {
			write: (data: string) => {
				const [code = "", printLine = ""] = data.split("\n");
				queueMicrotask(() => {
					session?.receive(
						`${code}\r\n${printLine}\r\n>>> ${code}\r\n>>> ${printLine}\r\n${evaluateSentinel(data)}\r\n>>> `,
					);
				});
			},
			kill: () => {},
		},
	});

	return session.exec("import json", { token: "aa1", timeoutMs: 500 }).then((result) => {
		assert.equal(result.raw.trim(), "");
		assert.equal(result.view.text.trim(), "");
	});
});

test("an expression's answer printed between the echoed lines survives", () => {
	// The other real shape, and the one a block-only fix destroys: python prints
	// the expression result after reading line 1, BEFORE echoing line 2.
	let session: KernelSession | undefined;
	session = new KernelSession({
		name: "interleaved",
		language: "python",
		process: {
			write: (data: string) => {
				const [code = "", printLine = ""] = data.split("\n");
				queueMicrotask(() => {
					session?.receive(`${code}\r\n7485000\r\n>>> ${printLine}\r\n${evaluateSentinel(data)}\r\n>>> `);
				});
			},
			kill: () => {},
		},
	});

	return session.exec("sum(x for x in rows)", { token: "int1", timeoutMs: 500 }).then((result) => {
		assert.equal(result.view.text.trim(), "7485000");
	});
});
