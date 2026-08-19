import assert from "node:assert/strict";
import { test } from "vitest";
import { createFakeProcesses } from "../../packages/coding-agent/src/core/capabilities/index.js";
import { CdpClient, CdpProtocolError } from "../../packages/coding-agent/src/extensions/browser/cdp-client.js";
import {
	ISOLATION_FLAGS,
	launchIsolatedChrome,
	resolveChromeExecutable,
} from "../../packages/coding-agent/src/extensions/browser/chrome-launcher.js";
import {
	formatCleanupReport,
	ResourceRegistry,
} from "../../packages/coding-agent/src/extensions/browser/resource-registry.js";
import {
	BrowserSession,
	removeDirWithStragglerRetry,
} from "../../packages/coding-agent/src/extensions/browser/session.js";
import { createFakeCdpTransport } from "./browser-fake-cdp.js";

const immediateTimer = (callback: () => void) => {
	const handle = setTimeout(callback, 0);
	return { cancel: () => clearTimeout(handle) };
};

test("correlates replies to the commands that asked for them", async () => {
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport });

	const first = client.send("Page.navigate", { url: "https://a.test" });
	const second = client.send("Runtime.evaluate", { expression: "1" });
	assert.deepEqual(
		transport.sent.map((command) => command.method),
		["Page.navigate", "Runtime.evaluate"],
	);

	// Answer out of order; each caller still gets its own result.
	transport.reply(transport.sent[1].id, { result: { value: 1 } });
	transport.reply(transport.sent[0].id, { frameId: "f1" });
	assert.deepEqual(await second, { result: { value: 1 } });
	assert.deepEqual(await first, { frameId: "f1" });
});

test("a protocol error rejects only its own command", async () => {
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport });
	const failing = client.send("Page.navigate");
	const fine = client.send("Runtime.evaluate");

	transport.replyError(transport.sent[0].id, { code: -32000, message: "Cannot navigate", data: "bad url" });
	transport.reply(transport.sent[1].id, { ok: true });

	await assert.rejects(failing, (error: unknown) => {
		assert.ok(error instanceof CdpProtocolError);
		assert.match(error.message, /Page\.navigate failed: Cannot navigate \(bad url\)/);
		return true;
	});
	assert.deepEqual(await fine, { ok: true });
});

test("a dropped connection rejects everything still in flight", async () => {
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport });
	const pending = client.send("Page.navigate");
	transport.drop("browser exited");

	await assert.rejects(pending, /Browser connection closed: browser exited/);
	assert.equal(client.isClosed, true);
	await assert.rejects(client.send("Runtime.evaluate"), /Browser connection closed/);
});

test("a command that is never answered times out instead of hanging the turn", async () => {
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport, timeoutMs: 5, setTimer: immediateTimer });
	// A method the fake does not answer, so the timeout is what settles it.
	await assert.rejects(client.send("Debugger.enable"), /Debugger\.enable timed out after 5ms/);
});

test("events reach subscribers, and a malformed frame is dropped rather than mis-correlated", async () => {
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport });
	const seen: Record<string, unknown>[] = [];
	client.on("Page.loadEventFired", (params) => seen.push(params));

	const pending = client.send("Page.navigate");
	transport.deliver("{ not json");
	transport.emit("Page.loadEventFired", { timestamp: 1 });
	transport.reply(transport.sent[0].id, { ok: true });

	assert.deepEqual(seen, [{ timestamp: 1 }]);
	assert.deepEqual(await pending, { ok: true });
});

test("cleanups run newest-first, all are attempted, and the registry ends empty", async () => {
	const registry = new ResourceRegistry();
	const order: string[] = [];
	registry.register("first", () => {
		order.push("first");
	});
	registry.register("second", () => {
		order.push("second");
		throw new Error("kill failed");
	});
	registry.register("third", async () => {
		order.push("third");
	});

	const report = await registry.release();

	assert.deepEqual(order, ["third", "second", "first"], "a failure must not stop the remaining cleanups");
	assert.equal(report.attempted, 3);
	assert.deepEqual(report.failures, [{ label: "second", error: "kill failed" }]);
	assert.equal(registry.size, 0);
	assert.match(formatCleanupReport(report) ?? "", /attempted 3 resource\(s\); 1 failed/);
});

test("a clean release reports no failures and leaves the registry reusable", async () => {
	const registry = new ResourceRegistry();
	registry.register("one", () => {});
	assert.equal(formatCleanupReport(await registry.release()), undefined);

	registry.register("after-release", () => {});
	assert.equal(registry.size, 1);
	assert.equal((await registry.release()).attempted, 1);
});

test("concurrent releases share one teardown", async () => {
	const registry = new ResourceRegistry();
	let runs = 0;
	registry.register("once", async () => {
		runs += 1;
	});
	const [a, b] = await Promise.all([registry.release(), registry.release()]);
	assert.equal(runs, 1);
	assert.equal(a.attempted, 1);
	assert.equal(b.attempted, 1);
});

test("the isolation flags pin a throwaway profile, never the user's", () => {
	assert.ok(!ISOLATION_FLAGS.some((flag) => flag.startsWith("--user-data-dir")));
	// --user-data-dir is supplied per launch from a fresh temp directory; the
	// launcher test below asserts it is present and points into that directory.
	assert.ok(ISOLATION_FLAGS.includes("--no-first-run"));
	assert.ok(ISOLATION_FLAGS.includes("--no-default-browser-check"));
});

test("resolveChromeExecutable prefers an explicit override and rejects a missing one", () => {
	assert.equal(
		resolveChromeExecutable({ override: "/opt/chrome", exists: (path) => path === "/opt/chrome" }),
		"/opt/chrome",
	);
	assert.equal(resolveChromeExecutable({ override: "/nope", exists: () => false }), undefined);
	assert.equal(
		resolveChromeExecutable({ platform: "linux", exists: (path) => path === "/usr/bin/chromium" }),
		"/usr/bin/chromium",
	);
});

test("a launch runs its own profile directory and reports the debugger endpoint", async () => {
	const processes = createFakeProcesses();
	const launched = await launchIsolatedChrome({
		processes,
		executablePath: "/usr/bin/chromium",
		port: 45123,
		createProfileDir: async () => "/tmp/profile-1",
		readDebuggerUrl: async (port) => `ws://127.0.0.1:${port}/devtools/browser/abc`,
	});

	assert.equal(launched.webSocketDebuggerUrl, "ws://127.0.0.1:45123/devtools/browser/abc");
	assert.equal(launched.userDataDir, "/tmp/profile-1");
	const [spawn] = processes.spawned;
	assert.equal(spawn.command, "/usr/bin/chromium");
	assert.ok(spawn.args.includes("--user-data-dir=/tmp/profile-1"), "the launch must pin its own profile");
	assert.ok(spawn.args.includes("--remote-debugging-port=45123"));
	assert.ok(spawn.args.includes("--headless=new"));
	for (const flag of ISOLATION_FLAGS) assert.ok(spawn.args.includes(flag), `missing isolation flag ${flag}`);
});

test("a launch that never comes up is killed and its profile removed", async () => {
	const processes = createFakeProcesses();
	const removed: string[] = [];
	await assert.rejects(
		launchIsolatedChrome({
			processes,
			executablePath: "/usr/bin/chromium",
			port: 45124,
			startupTimeoutMs: 1,
			sleep: async () => {},
			createProfileDir: async () => "/tmp/profile-2",
			removeProfileDir: async (path) => {
				removed.push(path);
			},
			readDebuggerUrl: async () => {
				throw new Error("connection refused");
			},
		}),
		/did not expose a DevTools endpoint|exited before its DevTools endpoint/,
	);
	assert.deepEqual(removed, ["/tmp/profile-2"], "a failed launch must not leave its profile behind");
	assert.equal(processes.alive, 0, "a failed launch must not leave the process running");
});

test("a session tears down its process, profile, and connection, then reports an empty registry", async () => {
	const processes = createFakeProcesses();
	const transport = createFakeCdpTransport();
	const removed: string[] = [];
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		launch: async () => ({
			handle: processes.spawn("/usr/bin/chromium", []),
			webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
			userDataDir: "/tmp/profile-3",
			port: 1,
		}),
		connect: async () => transport,
		removeProfileDir: async (path) => {
			removed.push(path);
		},
	});

	await session.start();
	assert.equal(session.isRunning, true);
	assert.equal(session.openResourceCount, 3);

	const report = await session.close();

	assert.deepEqual(report.failures, []);
	assert.equal(report.attempted, 3);
	assert.equal(session.openResourceCount, 0, "the registry must be empty after teardown");
	assert.equal(session.isRunning, false);
	assert.deepEqual(removed, ["/tmp/profile-3"]);
	assert.equal(processes.alive, 0);
	assert.equal(transport.closed, true);
});

test("a cleanup failure is reported rather than dressed up as a zero-orphan guarantee", async () => {
	const processes = createFakeProcesses();
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		launch: async () => ({
			handle: processes.spawn("/usr/bin/chromium", []),
			webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
			userDataDir: "/tmp/profile-4",
			port: 1,
		}),
		connect: async () => createFakeCdpTransport(),
		removeProfileDir: async () => {
			throw new Error("EBUSY: directory in use");
		},
	});
	await session.start();

	const report = await session.close();

	assert.equal(report.attempted, 3);
	assert.deepEqual(
		report.failures.map((failure) => failure.label),
		["chrome profile directory"],
	);
	assert.match(formatCleanupReport(report) ?? "", /EBUSY/);
	assert.equal(session.openResourceCount, 0);
});

test("acting before `open` is a clear error rather than a silent auto-start", () => {
	const session = new BrowserSession({ processes: createFakeProcesses(), executablePath: "/usr/bin/chromium" });
	assert.throws(() => session.require(), /The browser is not open/);
});

test("concurrent starts share one browser", async () => {
	const processes = createFakeProcesses();
	let launches = 0;
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		launch: async () => {
			launches += 1;
			return {
				handle: processes.spawn("/usr/bin/chromium", []),
				webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
				userDataDir: "/tmp/profile-5",
				port: 1,
			};
		},
		connect: async () => createFakeCdpTransport(),
		removeProfileDir: async () => {},
	});

	const [a, b] = await Promise.all([session.start(), session.start()]);
	assert.equal(launches, 1);
	assert.equal(a, b);
	await session.close();
});

test("a launch that fails after Chrome spawned kills it instead of stacking browsers", async () => {
	const processes = createFakeProcesses();
	const removed: string[] = [];
	let attempts = 0;
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		launch: async () => ({
			handle: processes.spawn("/usr/bin/chromium", []),
			webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
			userDataDir: `/tmp/profile-retry-${attempts}`,
			port: 1,
		}),
		connect: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("socket refused");
			return createFakeCdpTransport();
		},
		removeProfileDir: async (path) => {
			removed.push(path);
		},
	});

	await assert.rejects(session.start(), /socket refused/);
	assert.equal(processes.alive, 0, "the Chrome from the failed attempt must not stay running");
	assert.equal(session.openResourceCount, 0);
	assert.deepEqual(removed, ["/tmp/profile-retry-0"]);
	assert.equal(session.debuggerUrl, undefined, "a dead launch must not report a live-looking endpoint");

	// A retry starts fresh rather than stacking a second browser on a dead first.
	await session.start();
	assert.equal(processes.alive, 1);
	await session.close();
	assert.equal(processes.alive, 0);
});

test("a synchronously-firing injected timer cannot hang `send` or break `once`", async () => {
	// The pathological clock: the timeout callback runs during setTimer itself.
	const synchronousTimer = (callback: () => void) => {
		callback();
		return { cancel: () => {} };
	};
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport, timeoutMs: 5, setTimer: synchronousTimer });

	// Without register-before-arm, the timer misses the pending entry and the
	// command hangs forever instead of rejecting.
	await assert.rejects(client.send("Debugger.enable"), /Debugger\.enable timed out after 5ms/);
	// Without listener-before-timer, this is a ReferenceError from the temporal
	// dead zone rather than the documented timeout.
	await assert.rejects(client.once("Page.loadEventFired"), /Timed out waiting for Page\.loadEventFired/);
});

test("close settles `once` waiters with the close reason instead of a late timeout", async () => {
	const transport = createFakeCdpTransport();
	// A generous timeout: if close does not settle the waiter, this test hangs
	// on it rather than passing by accident.
	const client = new CdpClient({ transport, timeoutMs: 60_000 });
	const waiting = client.once("Page.loadEventFired");
	transport.drop("browser exited");
	await assert.rejects(waiting, /Browser connection closed: browser exited/);
	await assert.rejects(client.once("Page.loadEventFired"), /Browser connection closed/);
});

test("`once` scoped to a session ignores another target's events", async () => {
	// With flatten: true every attached target's events share one connection; a
	// page waiting on its own load event must not resolve on a sibling's.
	const transport = createFakeCdpTransport();
	const client = new CdpClient({ transport, timeoutMs: 5, setTimer: immediateTimer });
	const waiting = client.once("Page.loadEventFired", 5, "session-A");
	transport.emit("Page.loadEventFired", { timestamp: 1 }, "session-B");
	await assert.rejects(waiting, /Timed out waiting for Page\.loadEventFired/);

	const matched = client.once("Page.loadEventFired", 5, "session-A");
	transport.emit("Page.loadEventFired", { timestamp: 2 }, "session-A");
	assert.deepEqual(await matched, { timestamp: 2 });
});

test("a failed attach closes the target it created instead of leaving a page open", async () => {
	const transport = createFakeCdpTransport({
		handlers: {
			"Target.attachToTarget": () => {
				throw new Error("attach refused");
			},
		},
	});
	const client = new CdpClient({ transport });
	const { attachNewPage } = await import("../../packages/coding-agent/src/extensions/browser/page-session.js");

	await assert.rejects(attachNewPage(client), /attach refused/);
	const closed = transport.sent.find((command) => command.method === "Target.closeTarget");
	assert.deepEqual(closed?.params, { targetId: "target-1" }, "the created target must not outlive the failure");
});

test("close during an in-flight start still tears down the Chrome that launch registers", async () => {
	const processes = createFakeProcesses();
	let releaseLaunch: (() => void) | undefined;
	const launchGate = new Promise<void>((resolve) => {
		releaseLaunch = resolve;
	});
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		launch: async () => {
			await launchGate;
			return {
				handle: processes.spawn("/usr/bin/chromium", []),
				webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
				userDataDir: "/tmp/profile-racing",
				port: 1,
			};
		},
		connect: async () => createFakeCdpTransport(),
		removeProfileDir: async () => {},
	});

	const starting = session.start();
	// Shutdown arrives before the launch finished registering anything.
	const closing = session.close();
	releaseLaunch?.();
	await starting;
	const report = await closing;

	assert.deepEqual(report.failures, []);
	assert.equal(processes.alive, 0, "the Chrome the in-flight launch registered must not outlive the session");
	assert.equal(session.openResourceCount, 0);
});

test("connecting to a socket that never answers times out instead of hanging the open action", async () => {
	const { createServer } = await import("node:net");
	const server = createServer(() => {
		// Accept the TCP connection and say nothing: the WebSocket stays CONNECTING.
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	try {
		const { createWebSocketTransport } = await import(
			"../../packages/coding-agent/src/extensions/browser/cdp-client.js"
		);
		await assert.rejects(
			createWebSocketTransport(`ws://127.0.0.1:${port}/devtools`, { timeoutMs: 150 }),
			/Timed out connecting to the browser/,
		);
	} finally {
		server.close();
	}
});

test("an already-aborted signal rejects the connect immediately, before any socket opens", async () => {
	// The "abort" event fires once, at abort time. A listener registered on an
	// already-aborted signal never runs, so without an upfront check this
	// connect would wait out its full timeout and misreport the abort as one.
	const { createServer } = await import("node:net");
	let connections = 0;
	const server = createServer(() => {
		connections += 1;
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	try {
		const { createWebSocketTransport } = await import(
			"../../packages/coding-agent/src/extensions/browser/cdp-client.js"
		);
		await assert.rejects(
			createWebSocketTransport(`ws://127.0.0.1:${port}/devtools`, { timeoutMs: 150, signal: AbortSignal.abort() }),
			/was aborted/,
		);
		assert.equal(connections, 0, "no socket may be opened for an abort that already happened");
	} finally {
		server.close();
	}
});

test("profile removal retries once past a straggler, and still reports a held directory", async () => {
	// Chrome's helper processes can write into the profile for a beat after the
	// main process exits, which makes the first recursive remove fail ENOTEMPTY.
	const attempts: string[] = [];
	await removeDirWithStragglerRetry("/tmp/profile-straggler", async (path) => {
		attempts.push(path);
		if (attempts.length === 1) throw new Error("ENOTEMPTY: directory not empty");
	});
	assert.equal(attempts.length, 2, "the straggler window gets exactly one retry");

	// A directory that is genuinely held keeps failing, and the failure surfaces.
	await assert.rejects(
		removeDirWithStragglerRetry("/tmp/profile-held", async () => {
			throw new Error("EBUSY: directory in use");
		}),
		/EBUSY/,
	);
});

test("close resolves and reports the failure when Chrome ignores every kill signal", async () => {
	const processes = createFakeProcesses();
	// A wedged Chrome: kill signals land, the process never exits.
	const wedged = { pid: 4242, exited: new Promise<never>(() => {}), kill: () => {} };
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		killGraceMs: 20,
		launch: async () => ({
			handle: wedged,
			webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
			userDataDir: "/tmp/profile-wedged",
			port: 1,
		}),
		connect: async () => createFakeCdpTransport(),
		removeProfileDir: async () => {},
	});
	await session.start();

	const report = await session.close();

	assert.equal(report.attempted, 3, "an unkillable process must not stall the rest of the teardown");
	assert.deepEqual(
		report.failures.map((failure) => failure.label),
		["chrome process"],
	);
	assert.match(formatCleanupReport(report) ?? "", /did not exit after SIGKILL/);
	assert.equal(session.openResourceCount, 0);
});
