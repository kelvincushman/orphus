import assert from "node:assert/strict";
import { test } from "vitest";
import {
	describeJail,
	jailCommand,
	macosSandboxProfile,
} from "../../packages/coding-agent/src/core/repl/kernel-jail.js";
import { KernelRegistry } from "../../packages/coding-agent/src/core/repl/kernel-registry.js";
import {
	handleRepl,
	REPL_TOOL_DESCRIPTION,
	type ReplDeps,
} from "../../packages/coding-agent/src/core/repl/repl-tool.js";

/** A fake REPL: echoes what is written, adds the requested output, then the sentinel. */
function harness(options: { output?: string; spillPath?: string } = {}) {
	const registry = new KernelRegistry();
	const spilled: { name: string; chars: number }[] = [];
	let token = 0;

	const deps: ReplDeps = {
		registry,
		nextToken: () => {
			token += 1;
			return `t${token}`;
		},
		spill: (name, text) => {
			spilled.push({ name, chars: text.length });
			return options.spillPath ?? "/tmp/spill.txt";
		},
		spawn: ({ onData }) => ({
			jailNote: "jailed",
			process: {
				write: (data: string) => {
					const sentinel = /__ORPHUS_KERNEL_DONE_\w+__/.exec(data)?.[0] ?? "";
					// Asynchronously, as a real PTY would.
					queueMicrotask(() => onData(`${data}${options.output ?? ""}${sentinel}\n`));
				},
				kill: () => {},
			},
		}),
	};
	return { registry, deps, spilled };
}

test("open returns a name, never output", () => {
	// The whole point of a kernel: what it holds stays out of context until asked.
	const { deps } = harness();

	return handleRepl({ action: "open", session: "work" }, deps).then((answer) => {
		assert.match(answer, /^work \(python, jailed\)$/);
		assert.ok(answer.length < 60);
	});
});

test("a refused open reports the typed reason instead of throwing", () => {
	const { deps } = harness();

	return (async () => {
		for (const name of ["a", "b", "c", "d"]) await handleRepl({ action: "open", session: name }, deps);
		const answer = await handleRepl({ action: "open", session: "e" }, deps);

		assert.match(answer, /Refused \(capacityExhausted\)/);
		assert.match(answer, /at most 4 kernels/);
	})();
});

test("exec on an unopened kernel says so rather than throwing", () => {
	const { deps } = harness();
	return handleRepl({ action: "exec", session: "ghost", code: "1+1" }, deps).then((answer) => {
		assert.match(answer, /No kernel named 'ghost'/);
	});
});

test("close is honest about a kernel that was never open", () => {
	const { deps } = harness();
	return handleRepl({ action: "close", session: "ghost" }, deps).then((answer) => {
		assert.match(answer, /No kernel named 'ghost'/);
	});
});

test("list names what is open without running anything", () => {
	const { deps } = harness();
	return (async () => {
		assert.equal(await handleRepl({ action: "list" }, deps), "No kernels open.");
		await handleRepl({ action: "open", session: "work" }, deps);
		assert.equal(await handleRepl({ action: "list" }, deps), "Open kernels: work");
	})();
});

test("every action except list requires a session name", () => {
	const { deps } = harness();
	return (async () => {
		for (const action of ["open", "exec", "peek", "close"] as const) {
			await assert.rejects(() => handleRepl({ action }, deps), /requires a session name/);
		}
	})();
});

test("exec refuses to run nothing", () => {
	const { deps } = harness();
	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		assert.match(await handleRepl({ action: "exec", session: "work", code: "   " }, deps), /requires code/);
	})();
});

test("the tool description states it is not a sandbox", () => {
	// Rule 5 requires this where a reader meets the tool, not only in the docs.
	assert.match(REPL_TOOL_DESCRIPTION, /NOT a security sandbox/);
	assert.match(REPL_TOOL_DESCRIPTION, /user's permissions/);
});

test("the macOS profile denies writes but allows the workspace", () => {
	const profile = macosSandboxProfile("/Users/x/project");

	assert.match(profile, /\(deny file-write\*\)/);
	assert.match(profile, /\(allow file-write\* \(subpath "\/Users\/x\/project"\)\)/);
	// Reads stay broad on purpose: a Python REPL that cannot read its own stdlib
	// is useless, and a jail nobody enables protects nothing.
	assert.match(profile, /\(allow default\)/);
});

test("an unsupported platform is told plainly that nothing is jailed", () => {
	// The failure that matters: returning the plain command while the caller
	// believes it is jailed.
	const result = jailCommand({ platform: "unsupported", workspace: "/w", command: "python3", args: ["-q"] });

	assert.equal(result.jailed, false);
	assert.equal(result.command, "python3");
	assert.deepEqual(result.args, ["-q"]);
	assert.match(result.reason ?? "", /no jail profile exists/);
	assert.match(describeJail(result), /^NOT jailed:/);
});

test("a missing wrapper is not silently treated as a jail", () => {
	const result = jailCommand({
		platform: "linux",
		workspace: "/w",
		command: "python3",
		args: [],
		wrapperAvailable: false,
	});

	assert.equal(result.jailed, false);
	assert.equal(result.command, "python3");
	assert.match(result.reason ?? "", /not installed/);
});

test("each platform wraps with its own tool and keeps the workspace writable", () => {
	const mac = jailCommand({ platform: "darwin", workspace: "/w", command: "python3", args: ["-q"] });
	assert.equal(mac.command, "sandbox-exec");
	assert.ok(mac.args.includes("python3"));
	assert.ok(mac.args.includes("-q"));
	assert.equal(mac.jailed, true);

	const linux = jailCommand({ platform: "linux", workspace: "/w", command: "python3", args: ["-q"] });
	assert.equal(linux.command, "bwrap");
	assert.ok(linux.args.includes("--die-with-parent"));
	assert.deepEqual(linux.args.slice(-2), ["python3", "-q"]);
	assert.equal(linux.jailed, true);
});

test("even a jailed kernel is described without claiming safety", () => {
	const described = describeJail(jailCommand({ platform: "darwin", workspace: "/w", command: "python3", args: [] }));

	assert.match(described, /reduces exposure/);
	assert.match(described, /not a security sandbox/);
});

test("exec runs code in the kernel and returns what it printed", () => {
	// The happy path through the tool, which nothing covered while the harness
	// had no route for output to get back in.
	const { deps } = harness({ output: "42\n" });

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		const answer = await handleRepl({ action: "exec", session: "work", code: "6 * 7" }, deps);

		assert.match(answer, /42/);
		assert.doesNotMatch(answer, /ORPHUS_KERNEL_DONE/);
	})();
});

test("code that prints nothing costs one line, which is the whole point", () => {
	// `docs = open('big.json').read()` should cost this, not the file.
	const { deps } = harness({ output: "" });

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		const answer = await handleRepl({ action: "exec", session: "work", code: "docs = load()" }, deps);

		assert.match(answer, /^ok \(work, \d+ms, no output\)$/);
	})();
});

test("oversized output is bounded and points at the spill file", () => {
	const { deps, spilled } = harness({ output: `${"x".repeat(50_000)}\n`, spillPath: "/tmp/full.txt" });

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		const answer = await handleRepl({ action: "exec", session: "work", code: "print(big)" }, deps);

		assert.ok(answer.length < 6_000, `answer was ${answer.length} chars`);
		assert.match(answer, /not shown/);
		assert.match(answer, /full output: \/tmp\/full\.txt/);
		assert.equal(spilled.length, 1);
		assert.ok(spilled[0]!.chars > 40_000);
	})();
});

test("output that fits is not spilled at all", () => {
	// Spilling everything would put a pointer in front of the reader for a
	// two-line result, and train them to ignore it.
	const { deps, spilled } = harness({ output: "small\n" });

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		await handleRepl({ action: "exec", session: "work", code: "x" }, deps);
		assert.deepEqual(spilled, []);
	})();
});

test("a timeout says the kernel survived, because the obvious assumption is that it did not", () => {
	const registry = new KernelRegistry();
	const deps: ReplDeps = {
		registry,
		nextToken: () => "t1",
		// A process that never answers.
		spawn: () => ({ jailNote: "not jailed", process: { write: () => {}, kill: () => {} } }),
	};

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		const answer = await handleRepl({ action: "exec", session: "work", code: "hang()", timeoutMs: 5 }, deps);

		assert.match(answer, /did not finish within 5ms/);
		assert.match(answer, /still open and its values are intact/);
		assert.match(answer, /printed nothing before the timeout/);
	})();
});

test("peek shows the buffer without running anything", () => {
	const { deps } = harness({ output: "earlier\n" });

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		await handleRepl({ action: "exec", session: "work", code: "x" }, deps);
		const peeked = await handleRepl({ action: "peek", session: "work" }, deps);

		assert.match(peeked, /earlier/);
	})();
});

test("closing a kernel forgets it, so a later exec cannot reach a dead process", () => {
	const { deps } = harness({ output: "hi\n" });

	return (async () => {
		await handleRepl({ action: "open", session: "work" }, deps);
		assert.equal(await handleRepl({ action: "close", session: "work" }, deps), "Closed work.");
		assert.match(await handleRepl({ action: "exec", session: "work", code: "x" }, deps), /No kernel named 'work'/);
	})();
});
