import assert from "node:assert/strict";
import { test } from "vitest";
import {
	DEFAULT_KERNEL_IDLE_MS,
	type KernelProcess,
	KernelRefused,
	KernelRegistry,
	MAX_CONCURRENT_KERNELS,
} from "../../packages/coding-agent/src/core/repl/kernel-registry.js";

function fakeProcess(log: string[], name: string): KernelProcess {
	return {
		write: (data) => log.push(`${name}:write:${data}`),
		kill: () => log.push(`${name}:kill`),
	};
}

function registryWithClock(start = 1_000_000, options: { maxKernels?: number; idleMs?: number } = {}) {
	let clock = start;
	const log: string[] = [];
	const registry = new KernelRegistry({ ...options, now: () => clock });
	const spawn = (name: string) => () => fakeProcess(log, name);
	return { registry, log, spawn, advance: (ms: number) => (clock += ms) };
}

test("the cap matches subagent admission capacity", () => {
	// Same scarce thing: processes this machine will have running. A separate
	// budget would let the two doors together admit more than either allows.
	assert.equal(MAX_CONCURRENT_KERNELS, 4);
});

test("a fifth kernel is refused with a typed reason, not silently", () => {
	const { registry, spawn } = registryWithClock();
	for (const name of ["a", "b", "c", "d"]) registry.open(name, spawn(name));

	const error = (() => {
		try {
			registry.open("e", spawn("e"));
			return undefined;
		} catch (caught) {
			return caught;
		}
	})();

	assert.ok(error instanceof KernelRefused);
	assert.equal(error.kind, "capacityExhausted");
	assert.match(error.message, /at most 4 kernels/);
	// The refusal names what is open, so the caller can choose what to close.
	assert.match(error.message, /open: a, b, c, d/);
	assert.equal(registry.size, 4);
});

test("a refused open does not spawn the process it refused", () => {
	// Spawning and then refusing would leak the very process the cap exists to
	// prevent — the leak would be invisible, because the registry never held it.
	const { registry, log, spawn } = registryWithClock();
	for (const name of ["a", "b", "c", "d"]) registry.open(name, spawn(name));

	let spawned = false;
	assert.throws(
		() =>
			registry.open("e", () => {
				spawned = true;
				return fakeProcess(log, "e");
			}),
		KernelRefused,
	);

	assert.equal(spawned, false);
});

test("a duplicate name is refused rather than replacing a live kernel", () => {
	// Replacing would orphan the first process while the agent believed one
	// kernel existed all along.
	const { registry, log, spawn } = registryWithClock();
	registry.open("work", spawn("work"));

	assert.throws(
		() => registry.open("work", spawn("work2")),
		(error: unknown) => {
			return error instanceof KernelRefused && error.kind === "nameInUse";
		},
	);
	assert.deepEqual(log, []);
	assert.equal(registry.size, 1);
});

test("a hostile kernel name is refused", () => {
	const { registry, spawn } = registryWithClock();

	for (const bad of ["", "../escape", "a/b", "has space", "a".repeat(65)]) {
		assert.throws(
			() => registry.open(bad, spawn("x")),
			(error: unknown) => {
				return error instanceof KernelRefused && error.kind === "invalidName";
			},
			`expected ${JSON.stringify(bad)} to be refused`,
		);
	}
	assert.equal(registry.size, 0);
});

test("killAll kills every kernel — the zero-orphan guarantee", () => {
	const { registry, log, spawn } = registryWithClock();
	for (const name of ["a", "b", "c"]) registry.open(name, spawn(name));

	const killed = registry.killAll();

	assert.deepEqual(killed, ["a", "b", "c"]);
	assert.deepEqual(log, ["a:kill", "b:kill", "c:kill"]);
	assert.equal(registry.size, 0);
});

test("one kernel that throws on kill does not spare the others", () => {
	// The guarantee is about all of them. Abandoning the loop on the first
	// failure would leave the rest running with nobody holding a handle.
	const log: string[] = [];
	const registry = new KernelRegistry();
	registry.open("bad", () => ({
		write: () => {},
		kill: () => {
			throw new Error("already exited");
		},
	}));
	registry.open("good", () => fakeProcess(log, "good"));

	const killed = registry.killAll();

	assert.deepEqual(killed, ["bad", "good"]);
	assert.deepEqual(log, ["good:kill"]);
	assert.equal(registry.size, 0);
});

test("an idle kernel is reaped and named", () => {
	const reaped: string[] = [];
	let clock = 0;
	const log: string[] = [];
	const registry = new KernelRegistry({ idleMs: 1000, now: () => clock, onIdleReap: (name) => reaped.push(name) });
	registry.open("stale", () => fakeProcess(log, "stale"));

	clock += 1001;
	const names = registry.reapIdle();

	assert.deepEqual(names, ["stale"]);
	assert.deepEqual(reaped, ["stale"]);
	assert.deepEqual(log, ["stale:kill"]);
});

test("touch keeps a kernel alive; idleness is measured from last use", () => {
	let clock = 0;
	const log: string[] = [];
	const registry = new KernelRegistry({ idleMs: 1000, now: () => clock });
	registry.open("busy", () => fakeProcess(log, "busy"));

	clock += 900;
	registry.touch("busy");
	clock += 900;

	assert.deepEqual(registry.reapIdle(), []);
	assert.equal(registry.size, 1);
});

test("idle kernels are reaped before capacity is judged", () => {
	// Otherwise a session that left four kernels idle overnight could never open
	// another one, and the only remedy would be restarting the session.
	let clock = 0;
	const log: string[] = [];
	const registry = new KernelRegistry({ maxKernels: 2, idleMs: 1000, now: () => clock });
	registry.open("a", () => fakeProcess(log, "a"));
	registry.open("b", () => fakeProcess(log, "b"));

	clock += 1001;
	const kernel = registry.open("c", () => fakeProcess(log, "c"));

	assert.equal(kernel.name, "c");
	assert.deepEqual(registry.names(), ["c"]);
	assert.deepEqual(log, ["a:kill", "b:kill"]);
});

test("closing a kernel whose kill throws still removes it", () => {
	const registry = new KernelRegistry();
	registry.open("bad", () => ({
		write: () => {},
		kill: () => {
			throw new Error("already exited");
		},
	}));

	assert.equal(registry.close("bad"), true);
	assert.equal(registry.size, 0);
	assert.equal(registry.get("bad"), undefined);
});

test("closing an unknown kernel reports false rather than throwing", () => {
	assert.equal(new KernelRegistry().close("nope"), false);
});

test("the default idle timeout is stated, not implied", () => {
	assert.equal(DEFAULT_KERNEL_IDLE_MS, 30 * 60 * 1000);
});
