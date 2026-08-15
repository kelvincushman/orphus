import assert from "node:assert/strict";
import { test } from "vitest";
import {
	InheritRefused,
	parseInheritRequest,
	refuseIfMutating,
	resolveInherit,
} from "../../packages/coding-agent/src/core/repl/kernel-inherit.js";
import { KernelRegistry } from "../../packages/coding-agent/src/core/repl/kernel-registry.js";
import {
	createReplTool,
	currentJailPlatform,
	replEnabled,
	replJailRequested,
} from "../../packages/coding-agent/src/core/repl/repl-tool-definition.js";

function fakePtySession() {
	let onData: ((error: Error | null, chunk: string) => void) | undefined;
	return {
		session: {
			start: (_options: unknown, callback?: ((error: Error | null, chunk: string) => void) | null) => {
				onData = callback ?? undefined;
				return new Promise<void>(() => {});
			},
			write: (data: string) => {
				const sentinel = /__ORPHUS_KERNEL_DONE_\w+__/.exec(data)?.[0] ?? "";
				queueMicrotask(() => onData?.(null, `${data}${sentinel}\n`));
			},
			kill: () => {},
		},
	};
}

test("the tool is off unless someone switches it on", () => {
	// A tool that runs model-written code with the user's permissions must not
	// appear for a session that never asked for it.
	assert.equal(replEnabled({}), false);
	assert.equal(replEnabled({ ORPHUS_ENABLE_REPL: "0" }), false);
	assert.equal(replEnabled({ ORPHUS_ENABLE_REPL: "" }), false);
	assert.equal(replEnabled({ ORPHUS_ENABLE_REPL: "yes" }), false);

	assert.equal(replEnabled({ ORPHUS_ENABLE_REPL: "1" }), true);
	assert.equal(replEnabled({ ORPHUS_ENABLE_REPL: "true" }), true);
});

test("the jail is a separate switch from the tool", () => {
	// Enabling kernels and jailing them are different decisions; folding them
	// together would make the jail impossible to adopt incrementally.
	assert.equal(replJailRequested({ ORPHUS_ENABLE_REPL: "1" }), false);
	assert.equal(replJailRequested({ ORPHUS_REPL_JAIL: "1" }), true);
});

test("the platform maps to a jail profile or honestly to none", () => {
	assert.equal(currentJailPlatform("darwin"), "darwin");
	assert.equal(currentJailPlatform("linux"), "linux");
	assert.equal(currentJailPlatform("win32"), "unsupported");
	assert.equal(currentJailPlatform("freebsd"), "unsupported");
});

test("shutdown kills every kernel the session opened", () => {
	// The registry has to be reachable from teardown; one nobody can reach is one
	// nobody can empty, which is how a PTY outlives its session.
	const handle = createReplTool("/w", { createPtySession: () => fakePtySession().session });

	return (async () => {
		await handle.tool.execute("c1", { action: "open", session: "a" });
		await handle.tool.execute("c2", { action: "open", session: "b" });
		assert.equal(handle.registry.size, 2);

		assert.deepEqual(handle.shutdown(), ["a", "b"]);
		assert.equal(handle.registry.size, 0);
	})();
});

test("the tool returns text content like any other tool", () => {
	const handle = createReplTool("/w", { createPtySession: () => fakePtySession().session });

	return handle.tool.execute("c1", { action: "list" }).then((result) => {
		assert.deepEqual(result.content, [{ type: "text", text: "No kernels open." }]);
	});
});

test("each exec gets a distinct token, so one cannot resolve on another's sentinel", () => {
	const handle = createReplTool("/w", { createPtySession: () => fakePtySession().session });

	return (async () => {
		await handle.tool.execute("c1", { action: "open", session: "a" });
		const first = await handle.tool.execute("c2", { action: "exec", session: "a", code: "1" });
		const second = await handle.tool.execute("c3", { action: "exec", session: "a", code: "2" });
		// Both completed, which they could not if the second had resolved early on
		// the first's sentinel or been refused as busy.
		assert.ok(first.content[0]?.text !== undefined);
		assert.ok(second.content[0]?.text !== undefined);
	})();
});

test("without the native binding the tool says so instead of failing obscurely", () => {
	const handle = createReplTool("/w");

	return assert.rejects(
		() => handle.tool.execute("c1", { action: "open", session: "a" }),
		/requires the native PTY binding/,
	);
});

test("bare inherit means read-only, the safe reading of an ambiguous word", () => {
	// A caller who did not think about it gets the narrower grant.
	assert.deepEqual(parseInheritRequest("inherit", "work"), { kernel: "work", mode: "read-only" });
	assert.deepEqual(parseInheritRequest(true, "work"), { kernel: "work", mode: "read-only" });
	assert.deepEqual(parseInheritRequest({ inherit: "work" }, undefined), { kernel: "work", mode: "read-only" });
});

test("read-write must be asked for by name", () => {
	assert.deepEqual(parseInheritRequest({ inherit: "work", mode: "read-write" }, undefined), {
		kernel: "work",
		mode: "read-write",
	});
	assert.throws(() => parseInheritRequest({ inherit: "work", mode: "rw" }, undefined), InheritRefused);
});

test("no inherit request yields no grant", () => {
	assert.equal(parseInheritRequest(undefined, "work"), undefined);
	assert.equal(parseInheritRequest(false, "work"), undefined);
});

test("inheriting from a parent with no kernel is refused, not silently ignored", () => {
	assert.throws(() => parseInheritRequest("inherit", undefined), /the parent has no open kernel/);
});

test("inheriting a kernel that is not open is refused and names what is", () => {
	// A child told it inherited a kernel that does not exist would run its code
	// somewhere unexpected, or nowhere.
	const registry = new KernelRegistry();
	registry.open("real", () => ({ write: () => {}, kill: () => {} }));

	assert.throws(
		() => resolveInherit({ kernel: "imaginary", mode: "read-only" }, registry),
		/cannot inherit 'imaginary'.*open: real/s,
	);
	assert.deepEqual(resolveInherit({ kernel: "real", mode: "read-only" }, registry), {
		kernel: "real",
		readOnly: true,
	});
});

test("read-only refuses the obvious mutations and says it is only a guardrail", () => {
	for (const code of ["x = 1", "data['k'] = 2", "del x", "obj.field = 3", "items.append(4)", "d.update(e)"]) {
		const refusal = refuseIfMutating(code, true);
		assert.ok(refusal, `expected ${JSON.stringify(code)} to be refused`);
		assert.match(refusal, /guardrail rather than a sandbox/);
		assert.match(refusal, /read-write/);
	}
});

test("read-only allows reading, and read-write allows everything", () => {
	for (const code of ["len(docs)", "docs[0]", "print(x == 1)", "sum(v for v in values)"]) {
		assert.equal(refuseIfMutating(code, true), undefined, `${code} should be allowed`);
	}
	assert.equal(refuseIfMutating("x = 1", false), undefined);
});
