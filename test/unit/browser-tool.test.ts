import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { createFakeProcesses, nodeProcesses } from "../../packages/coding-agent/src/core/capabilities/index.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/context-types.js";
import { UncertainActionError } from "../../packages/coding-agent/src/extensions/browser/actions.js";
import { resolveChromeExecutable } from "../../packages/coding-agent/src/extensions/browser/chrome-launcher.js";
import { readBrowserFlags } from "../../packages/coding-agent/src/extensions/browser/env.js";
import browserExtension from "../../packages/coding-agent/src/extensions/browser/index.js";
import { BrowserSession } from "../../packages/coding-agent/src/extensions/browser/session.js";
import { BROWSER_TOOL_NAME, createBrowserTool } from "../../packages/coding-agent/src/extensions/browser/tool.js";
import { createFakeCdpTransport, evaluateHandler, type FakeCdpTransport } from "./browser-fake-cdp.js";

const SECRET = "hunter2-do-not-disclose";

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function harness(options?: {
	evaluate?: (expression: string) => unknown;
	loginEnabled?: boolean;
	loginOrigins?: string;
	credentials?: { label: string; origin: string; username?: string; secret: string }[];
	approve?: boolean;
}) {
	const processes = createFakeProcesses();
	const transport: FakeCdpTransport = createFakeCdpTransport({
		handlers: {
			// The default stands in for a real page: status reads return the page
			// object, and `click`/`type` report that they found their element.
			"Runtime.evaluate": evaluateHandler(
				options?.evaluate ??
					((expression) =>
						expression.includes("location.href")
							? { url: "https://app.test/signin", title: "Sign in", text: "body" }
							: true),
			),
			"Page.captureScreenshot": () => ({ data: "iVBORw0KGgo=" }),
		},
	});
	const session = new BrowserSession({
		processes,
		executablePath: "/usr/bin/chromium",
		launch: async () => ({
			handle: processes.spawn("/usr/bin/chromium", []),
			webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools",
			userDataDir: "/tmp/profile",
			port: 1,
		}),
		connect: async () => transport,
		removeProfileDir: async () => {},
	});
	const entries = options?.credentials ?? [{ label: "app-login", origin: "https://app.test", secret: SECRET }];
	const confirmations: string[] = [];
	const ctx = {
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push(`${title} ${message}`);
				return options?.approve ?? true;
			},
		},
	} as unknown as ExtensionContext;
	const tool = createBrowserTool({
		session,
		credentials: {
			kind: "test",
			list: async () => entries.map(({ label, origin, username }) => ({ label, origin, username })),
			reveal: async (label: string) => entries.find((entry) => entry.label === label)?.secret,
		},
		flags: {
			enabled: true,
			loginEnabled: options?.loginEnabled ?? true,
			loginOrigins: options?.loginOrigins ?? "https://app.test",
			executablePath: undefined,
			headless: true,
			noSandbox: false,
		},
	});
	const run = (params: Record<string, unknown>) =>
		tool.execute("call-1", params as never, undefined, undefined, ctx) as Promise<AgentToolResult<unknown>>;
	return { tool, run, session, transport, processes, confirmations };
}

test("the tool is one action-dispatched surface, and every action shares one session", async () => {
	const { tool, run, session, processes } = harness();
	assert.equal(tool.name, BROWSER_TOOL_NAME);
	assert.equal(tool.executionMode, "sequential");

	await run({ action: "open" });
	await run({ action: "navigate", url: "https://app.test/signin" });
	const status = await run({ action: "status" });

	assert.match(textOf(status), /app\.test/);
	assert.equal(processes.spawned.length, 1, "one browser serves every action");
	await session.close();
});

test("acting before open is an error, not a silent launch", async () => {
	const { run, processes } = harness();
	await assert.rejects(run({ action: "snapshot" }), /The browser is not open/);
	assert.equal(processes.spawned.length, 0);
});

test("a failed page-changing action surfaces as uncertainty through the tool", async () => {
	const { run, session } = harness({
		evaluate: () => {
			throw new Error("target crashed");
		},
	});
	await run({ action: "open" });
	await assert.rejects(run({ action: "click", selector: "#go" }), (error: unknown) => {
		assert.ok(error instanceof UncertainActionError);
		assert.match(error.message, /Use `snapshot` to see the page's current state/);
		return true;
	});
	await session.close();
});

test("login asks for approval, and reports only the label", async () => {
	const { run, session, confirmations } = harness();
	await run({ action: "open" });
	const result = await run({
		action: "login",
		credentialLabel: "app-login",
		selector: "#pass",
		submitSelector: "#go",
	});

	const output = textOf(result);
	assert.match(output, /credential "app-login"/);
	assert.ok(!output.includes(SECRET), "the secret must never reach model-visible content");
	assert.equal(confirmations.length, 1);
	assert.ok(!confirmations[0].includes(SECRET), "the approval prompt names the credential, not the secret");
	assert.match(confirmations[0], /app\.test/);

	// The whole point of once-per-session approval: a second login with the same
	// credential on the same origin does not ask again.
	await run({ action: "login", credentialLabel: "app-login", selector: "#pass" });
	assert.equal(confirmations.length, 1, "approval is remembered for the tool's lifetime, not per call");
	await session.close();
});

test("a page that navigates away while approval is pending never receives the secret", async () => {
	// The origin check and the fill are separated by the approval prompt —
	// human-scale time. A redirect in that window must abort the login.
	let statusReads = 0;
	const { run, session, transport } = harness({
		evaluate: (expression) => {
			if (!expression.includes("location.href")) return true;
			statusReads += 1;
			return statusReads === 1
				? { url: "https://app.test/signin", title: "Sign in", text: "body" }
				: { url: "https://evil.test/phish", title: "Totally the same site", text: "body" };
		},
	});
	await run({ action: "open" });

	await assert.rejects(
		run({ action: "login", credentialLabel: "app-login", selector: "#pass" }),
		/left https:\/\/app\.test before the login was submitted/,
	);
	const evaluated = transport.sent.filter((command) => command.method === "Runtime.evaluate");
	assert.ok(
		evaluated.every((command) => !JSON.stringify(command.params ?? {}).includes(SECRET)),
		"no fill expression carrying the secret may be dispatched after the move",
	);
	await session.close();
});

test("login on an origin outside the allowlist is a tool error naming no secret", async () => {
	const { run, session } = harness({ loginOrigins: "https://elsewhere.test" });
	await run({ action: "open" });
	await assert.rejects(run({ action: "login", credentialLabel: "app-login", selector: "#pass" }), (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		assert.match(message, /not on the browser login allowlist/);
		assert.ok(!message.includes(SECRET));
		return true;
	});
	await session.close();
});

test("login with the login switch off is refused even on an allowlisted origin", async () => {
	const { run, session } = harness({ loginEnabled: false });
	await run({ action: "open" });
	await assert.rejects(
		run({ action: "login", credentialLabel: "app-login", selector: "#pass" }),
		/ORPHUS_ENABLE_BROWSER_LOGIN/,
	);
	await session.close();
});

test("a declined approval refuses the login", async () => {
	const { run, session } = harness({ approve: false });
	await run({ action: "open" });
	await assert.rejects(
		run({ action: "login", credentialLabel: "app-login", selector: "#pass" }),
		/was not approved for this origin/,
	);
	await session.close();
});

test("close reports its cleanup and empties the registry", async () => {
	const { run, session } = harness();
	await run({ action: "open" });
	const result = await run({ action: "close" });
	assert.match(textOf(result), /Browser closed\. 3 resource\(s\) released, none failed\./);
	assert.equal(session.openResourceCount, 0);
});

/**
 * The extension reads the whole `ORPHUS_*BROWSER*` family, so these tests
 * must not inherit whatever the developer's or CI's ambient environment says —
 * a stray `ORPHUS_ENABLE_BROWSER_LOGIN=1` would route them into the keychain
 * wiring they do not mean to exercise.
 */
const BROWSER_ENV_KEYS = [
	"ORPHUS_ENABLE_BROWSER",
	"ORPHUS_ENABLE_BROWSER_LOGIN",
	"ORPHUS_BROWSER_LOGIN_ORIGINS",
	"ORPHUS_BROWSER_EXECUTABLE",
	"ORPHUS_BROWSER_HEADLESS",
	"ORPHUS_BROWSER_NO_SANDBOX",
] as const;

function withBrowserEnv<T>(overrides: Record<string, string>, body: () => T): T {
	const previous = new Map(BROWSER_ENV_KEYS.map((key) => [key, process.env[key]] as const));
	for (const key of BROWSER_ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
	try {
		return body();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("the extension registers the browser tool by default", () => {
	const registered: string[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => registered.push(tool.name),
		on: () => {},
	} as never;
	withBrowserEnv({}, () => {
		browserExtension(pi);
	});
	assert.deepEqual(registered, [BROWSER_TOOL_NAME]);
});

test("false-like browser switch values prevent registration", () => {
	for (const value of ["0", "false", "off", ""]) {
		const registered: string[] = [];
		const pi = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
			on: () => {},
		} as never;
		withBrowserEnv({ ORPHUS_ENABLE_BROWSER: value }, () => {
			assert.equal(readBrowserFlags().enabled, false);
			browserExtension(pi);
		});
		assert.deepEqual(registered, [], value);
	}
});

/**
 * The one test that drives a real browser. It is skipped rather than failed
 * where no Chrome exists, because "we could not check this here" and "this is
 * broken" are different statements and only one of them should stop a build.
 */
const REAL_CHROME_SMOKE_TIMEOUT_MS = 60_000;
// The launcher's own 15s budget is sized for a person waiting on a browser. A
// CI runner building 670 test files in parallel is not that, and Chrome missed
// it there while the test still had 45s of its budget unspent. The launch gets
// most of the test's budget; what remains covers navigate, evaluate, teardown.
const REAL_CHROME_STARTUP_TIMEOUT_MS = 40_000;
const chromePath = resolveChromeExecutable();
const smokeTest = chromePath ? test : test.skip;

smokeTest(
	"a real isolated Chrome launches, navigates, reads back, and tears down",
	async () => {
		const session = new BrowserSession({
			processes: nodeProcesses,
			executablePath: chromePath,
			headless: true,
			// Chrome refuses to start as root with its sandbox on. That is a
			// property of this runner, not of the product, so the smoke test opts
			// out where it must rather than the shipped launcher doing it for
			// everyone.
			noSandbox: process.getuid?.() === 0,
			startupTimeoutMs: REAL_CHROME_STARTUP_TIMEOUT_MS,
		});
		try {
			await session.start();
			const client = session.require();
			await client.send("Page.enable");
			await client.send("Page.navigate", { url: "data:text/html,<title>Orphus</title><p id=hello>hi</p>" });
			// Poll rather than wait on a load event: a data: URL can finish before
			// the subscription lands.
			let title = "";
			for (let attempt = 0; attempt < 40 && title !== "Orphus"; attempt++) {
				const evaluated = (await client.send("Runtime.evaluate", {
					expression: "document.title",
					returnByValue: true,
				})) as { result?: { value?: string } };
				title = evaluated.result?.value ?? "";
				if (title !== "Orphus") await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(title, "Orphus");
		} finally {
			const report = await session.close();
			assert.deepEqual(report.failures, []);
			assert.equal(session.openResourceCount, 0);
		}
	},
	// Structural: launching a real browser, waiting for its DevTools endpoint, and
	// tearing the process down is process-startup cost, not a slow test.
	REAL_CHROME_SMOKE_TIMEOUT_MS,
);
