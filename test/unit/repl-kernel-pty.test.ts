import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createPtyKernel,
	launchCommandFor,
	type PtySessionLike,
	shellJoin,
} from "../../packages/coding-agent/src/core/repl/kernel-pty.js";

type StartOptions = Parameters<PtySessionLike["start"]>[0];

function fakePty() {
	const calls: { start?: StartOptions; writes: string[]; killed: boolean } = { writes: [], killed: false };
	let resolveExit: (() => void) | undefined;
	let emit: ((chunk: string) => void) | undefined;

	const session: PtySessionLike = {
		start: (options, onChunk) => {
			calls.start = options;
			emit = (chunk) => onChunk?.(null, chunk);
			return new Promise<void>((resolve) => {
				resolveExit = resolve;
			});
		},
		write: (data) => calls.writes.push(data),
		kill: () => {
			calls.killed = true;
		},
	};
	return { session, calls, exit: () => resolveExit?.(), emit: (text: string) => emit?.(text) };
}

test("stdin stays open, or the kernel is a one-shot", () => {
	// The single detail that separates a kernel from `bash`. A REPL reads until
	// stdin closes; closing it after the launch command ends the session.
	const { session, calls } = fakePty();

	createPtyKernel({
		language: "python",
		cwd: "/w",
		onData: () => {},
		createSession: () => session,
	});

	assert.equal(calls.start?.closeStdinAfterCommand, false);
});

test("no process-level timeout is set, because that would kill every value", () => {
	// The per-exec timeout lives in KernelSession. A timeout here would take the
	// whole kernel down along with everything in it.
	const { session, calls } = fakePty();

	createPtyKernel({ language: "python", cwd: "/w", onData: () => {}, createSession: () => session });

	assert.ok(!("timeoutMs" in (calls.start ?? {})), "the PTY must not be given a timeout");
});

test("output reaches the caller as text", () => {
	const received: string[] = [];
	const { session, emit } = fakePty();

	createPtyKernel({
		language: "python",
		cwd: "/w",
		onData: (chunk) => received.push(chunk),
		createSession: () => session,
	});
	emit(">>> 42\n");

	assert.deepEqual(received, [">>> 42\n"]);
});

test("an unexpected exit is reported rather than leaving a corpse in the registry", () => {
	const exits: string[] = [];
	const { session, exit } = fakePty();

	createPtyKernel({
		language: "python",
		cwd: "/w",
		onData: () => {},
		createSession: () => session,
		onExit: (reason) => exits.push(reason),
	});
	exit();

	// start() resolves on process exit, so the notification lands on a later tick.
	return Promise.resolve().then(() => {
		assert.deepEqual(exits, ["the kernel process exited"]);
	});
});

test("writes and kills reach the session", () => {
	const { session, calls } = fakePty();

	const kernel = createPtyKernel({
		language: "python",
		cwd: "/w",
		onData: () => {},
		createSession: () => session,
	});
	kernel.process.write("1+1\n");
	kernel.process.kill();

	assert.deepEqual(calls.writes, ["1+1\n"]);
	assert.equal(calls.killed, true);
});

test("python launches unbuffered, so a sentinel cannot sit in a pipe buffer", () => {
	// exec waits for the sentinel. Buffered output would make every call hang
	// until the buffer happened to flush.
	assert.deepEqual(launchCommandFor("python"), { command: "python3", args: ["-q", "-u", "-i"] });
	assert.deepEqual(launchCommandFor("node"), { command: "node", args: ["-i"] });
});

test("an unjailed kernel says so, and never implies otherwise", () => {
	const { session } = fakePty();

	const plain = createPtyKernel({ language: "python", cwd: "/w", onData: () => {}, createSession: () => session });
	assert.equal(plain.jailNote, "not jailed");

	const unsupported = createPtyKernel({
		language: "python",
		cwd: "/w",
		jail: true,
		platform: "unsupported",
		onData: () => {},
		createSession: () => fakePty().session,
	});
	assert.match(unsupported.jailNote, /^NOT jailed:/);
});

test("a jailed kernel launches through the wrapper and still refuses to claim safety", () => {
	const { session, calls } = fakePty();

	const kernel = createPtyKernel({
		language: "python",
		cwd: "/w",
		jail: true,
		platform: "darwin",
		onData: () => {},
		createSession: () => session,
	});

	assert.match(calls.start?.command ?? "", /^sandbox-exec /);
	assert.match(calls.start?.command ?? "", /python3/);
	assert.match(kernel.jailNote, /reduces exposure/);
	assert.match(kernel.jailNote, /not a security sandbox/);
});

test("the jail profile survives the shell it is passed through", () => {
	// PtySession takes a command LINE, not an argv. The macOS profile is a
	// multi-line s-expression full of parentheses; a naive join(" ") hands the
	// shell a syntax error, and the kernel comes up unjailed or not at all.
	const { session, calls } = fakePty();

	createPtyKernel({
		language: "python",
		cwd: "/w",
		jail: true,
		platform: "darwin",
		onData: () => {},
		createSession: () => session,
	});

	const command = calls.start?.command ?? "";
	// The whole profile is one quoted argument, so its parens and newlines are
	// inert rather than shell syntax.
	assert.match(command, /^sandbox-exec -p '\(version 1\)/);
	assert.match(command, /' python3 -q -u -i$/);
});

test("shellJoin leaves simple arguments alone and quotes everything else", () => {
	assert.equal(shellJoin("python3", ["-q", "-u"]), "python3 -q -u");
	assert.equal(shellJoin("cmd", ["a b"]), "cmd 'a b'");
	assert.equal(shellJoin("cmd", ["(paren)"]), "cmd '(paren)'");
	assert.equal(shellJoin("cmd", ["line\nbreak"]), "cmd 'line\nbreak'");
	// The one case that would break out of the quoting if mishandled.
	assert.equal(shellJoin("cmd", ["it's"]), `cmd 'it'\\''s'`);
});
