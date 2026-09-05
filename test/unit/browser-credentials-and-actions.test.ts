import assert from "node:assert/strict";
import { test } from "vitest";
import { createFakeFileSystem, createFakeProcesses } from "../../packages/coding-agent/src/core/capabilities/index.js";
import {
	navigate,
	retryObservation,
	runMutating,
	snapshot,
	submitLogin,
	typeInto,
	UncertainActionError,
} from "../../packages/coding-agent/src/extensions/browser/actions.js";
import { CdpClient } from "../../packages/coding-agent/src/extensions/browser/cdp-client.js";
import {
	CredentialGate,
	describeDenial,
	parseOriginAllowlist,
} from "../../packages/coding-agent/src/extensions/browser/credential-gate.js";
import { readBrowserFlags } from "../../packages/coding-agent/src/extensions/browser/env.js";
import {
	CREDENTIAL_REGISTRY_FILE,
	createKeychainCredentials,
	KEYCHAIN_SERVICE,
	keychainLookupCommand,
} from "../../packages/coding-agent/src/extensions/browser/keychain-credentials.js";
import { createFakeCdpTransport, evaluateHandler } from "./browser-fake-cdp.js";

const SECRET = "hunter2-do-not-disclose";

function vault(entries: { label: string; origin: string; username?: string; secret: string }[] = []) {
	const reveals: string[] = [];
	return {
		reveals,
		capability: {
			kind: "test-vault",
			list: async () => entries.map(({ label, origin, username }) => ({ label, origin, username })),
			reveal: async (label: string) => {
				reveals.push(label);
				return entries.find((entry) => entry.label === label)?.secret;
			},
		},
	};
}

const ALLOWED = new Set(["https://app.test"]);

function gate(options: {
	loginEnabled?: boolean;
	allowlist?: Set<string>;
	approve?: (request: { label: string; origin: string }) => Promise<boolean>;
	entries?: { label: string; origin: string; username?: string; secret: string }[];
}) {
	const store = vault(options.entries ?? [{ label: "app-login", origin: "https://app.test", secret: SECRET }]);
	return {
		store,
		gate: new CredentialGate({
			credentials: store.capability,
			loginEnabled: options.loginEnabled ?? true,
			allowlist: options.allowlist ?? ALLOWED,
			approve: options.approve,
		}),
	};
}

test("browser operation is on by default, has an explicit opt-out, and login remains separately gated", () => {
	assert.deepEqual(readBrowserFlags({}).enabled, true);
	assert.deepEqual(readBrowserFlags({}).loginEnabled, false);
	assert.deepEqual(readBrowserFlags({ ORPHUS_ENABLE_BROWSER_LOGIN: "1" }).loginEnabled, true);
	assert.deepEqual(readBrowserFlags({ ORPHUS_ENABLE_BROWSER: "1" }).loginEnabled, false);
	const both = readBrowserFlags({ ORPHUS_ENABLE_BROWSER: "1", ORPHUS_ENABLE_BROWSER_LOGIN: "1" });
	assert.deepEqual([both.enabled, both.loginEnabled], [true, true]);
	for (const value of ["0", "false", "off", ""]) {
		const disabled = readBrowserFlags({ ORPHUS_ENABLE_BROWSER: value, ORPHUS_ENABLE_BROWSER_LOGIN: "1" });
		assert.deepEqual([disabled.enabled, disabled.loginEnabled], [false, false], value);
	}
	assert.equal(readBrowserFlags({ ORPHUS_ENABLE_BROWSER: "1" }).headless, true);
	assert.equal(readBrowserFlags({ ORPHUS_ENABLE_BROWSER: "1", ORPHUS_BROWSER_HEADLESS: "0" }).headless, false);
});

test("disabling Chrome's sandbox takes an explicit affirmative, not any non-empty value", () => {
	// `--no-sandbox` removes a security boundary; "no" and "disabled" must not
	// count as yes the way the loose parser used elsewhere would read them.
	for (const value of ["1", "true", "on", "yes", " TRUE "]) {
		assert.equal(readBrowserFlags({ ORPHUS_BROWSER_NO_SANDBOX: value }).noSandbox, true, value);
	}
	for (const value of ["no", "disabled", "enable", "sandbox", "0", "false", "off", ""]) {
		assert.equal(readBrowserFlags({ ORPHUS_BROWSER_NO_SANDBOX: value }).noSandbox, false, value);
	}
});

test("the allowlist takes origins, not bare hosts", () => {
	const parsed = parseOriginAllowlist("https://app.test, http://localhost:3000 app.test");
	assert.deepEqual([...parsed].sort(), ["http://localhost:3000", "https://app.test"]);
	assert.equal(parsed.has("http://app.test"), false, "a scheme-less entry must not authorize http");
	assert.deepEqual([...parseOriginAllowlist(undefined)], []);
});

test("login denied while the login switch is off, without touching the vault", async () => {
	const { gate: subject, store } = gate({ loginEnabled: false, approve: async () => true });
	const decision = await subject.resolve("app-login", "https://app.test/signin");
	assert.equal(decision.ok, false);
	assert.equal(decision.ok === false && decision.denial.reason, "login_disabled");
	assert.deepEqual(store.reveals, [], "a denied request must never read a secret");
});

test("login denied on an origin that is not allowlisted", async () => {
	const { gate: subject, store } = gate({ approve: async () => true });
	const decision = await subject.resolve("app-login", "https://evil.test/signin");
	assert.equal(decision.ok === false && decision.denial.reason, "origin_not_allowlisted");
	assert.deepEqual(store.reveals, []);
});

test("a credential scoped to one origin cannot be used on another allowlisted one", async () => {
	const { gate: subject, store } = gate({
		allowlist: new Set(["https://app.test", "https://other.test"]),
		approve: async () => true,
		entries: [{ label: "app-login", origin: "https://other.test", secret: SECRET }],
	});
	const decision = await subject.resolve("app-login", "https://app.test/signin");
	assert.equal(decision.ok === false && decision.denial.reason, "credential_origin_mismatch");
	assert.deepEqual(store.reveals, []);
});

test("an unattended session cannot approve its own credential use", async () => {
	const { gate: subject, store } = gate({ approve: undefined });
	const decision = await subject.resolve("app-login", "https://app.test/signin");
	assert.equal(decision.ok === false && decision.denial.reason, "no_approver");
	assert.deepEqual(store.reveals, [], "with nobody to ask, nothing is revealed");
});

test("a declined approval denies, and the secret is never read", async () => {
	const { gate: subject, store } = gate({ approve: async () => false });
	const decision = await subject.resolve("app-login", "https://app.test/signin");
	assert.equal(decision.ok === false && decision.denial.reason, "approval_denied");
	assert.deepEqual(store.reveals, []);
});

test("approval is asked once per credential and origin, then reused", async () => {
	const asked: { label: string; origin: string }[] = [];
	const { gate: subject, store } = gate({
		approve: async (request) => {
			asked.push(request);
			return true;
		},
	});

	const first = await subject.resolve("app-login", "https://app.test/signin");
	const second = await subject.resolve("app-login", "https://app.test/account");

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(asked.length, 1, "first use asks; later uses on the same origin do not");
	assert.deepEqual(asked[0], { label: "app-login", origin: "https://app.test", username: undefined });
	assert.deepEqual(store.reveals, ["app-login", "app-login"]);
	assert.equal(first.ok === true && first.grant.secret, SECRET);
});

test("only the label appears in what a denial says", () => {
	const messages = [
		describeDenial({ reason: "login_disabled" }, "app-login"),
		describeDenial({ reason: "origin_not_allowlisted", origin: "https://evil.test" }, "app-login"),
		describeDenial({ reason: "approval_denied" }, "app-login"),
		describeDenial({ reason: "no_approver" }, "app-login"),
	];
	for (const message of messages) {
		assert.ok(!message.includes(SECRET));
		assert.ok(message.length > 0);
	}
	assert.match(messages[1], /app-login/);
});

test("listing credentials for a page never leaves the allowlist", async () => {
	const { gate: subject } = gate({
		entries: [
			{ label: "app-login", origin: "https://app.test", secret: SECRET },
			{ label: "other", origin: "https://evil.test", secret: SECRET },
		],
	});
	assert.deepEqual(
		(await subject.listFor("https://app.test/x")).map((record) => record.label),
		["app-login"],
	);
	assert.deepEqual(await subject.listFor("https://evil.test/x"), []);
});

test("the keychain vault reads the secret from the OS and the metadata from its own registry", async () => {
	const fs = createFakeFileSystem({
		[`/agent/${CREDENTIAL_REGISTRY_FILE}`]: JSON.stringify([
			{ label: "app-login", origin: "https://app.test", username: "ada" },
		]),
	});
	const processes = createFakeProcesses();
	processes.script("security", { result: { code: 0, stdout: `${SECRET}\n`, stderr: "" } });
	const credentials = createKeychainCredentials({
		processes,
		fs,
		registryPath: `/agent/${CREDENTIAL_REGISTRY_FILE}`,
		platform: "darwin",
	});

	assert.equal(credentials.kind, "macos-keychain");
	assert.deepEqual(await credentials.list(), [{ label: "app-login", origin: "https://app.test", username: "ada" }]);
	assert.equal(await credentials.reveal("app-login"), SECRET);
	// The registry file holds no secret — that is the whole point of the split.
	assert.ok(!fs.files.get(`/agent/${CREDENTIAL_REGISTRY_FILE}`)?.data.includes(SECRET));
	assert.deepEqual(processes.spawned[0].args, [
		"find-generic-password",
		"-s",
		KEYCHAIN_SERVICE,
		"-a",
		"app-login",
		"-w",
	]);
});

test("an unreadable credential is indistinguishable from an absent one", async () => {
	const processes = createFakeProcesses();
	processes.script("secret-tool", { result: { code: 1, stdout: "", stderr: "no such secret" } });
	const credentials = createKeychainCredentials({
		processes,
		fs: createFakeFileSystem(),
		registryPath: "/agent/missing.json",
		platform: "linux",
	});
	assert.equal(await credentials.reveal("app-login"), undefined);
	assert.deepEqual(await credentials.list(), [], "no registry means no credentials, not a crash");
});

test("a registry entry with a non-string username is dropped at the parse boundary", async () => {
	// The registry is user-edited JSON; a wrong type here would otherwise be
	// typed into a login form as "[object Object]".
	const fs = createFakeFileSystem({
		[`/agent/${CREDENTIAL_REGISTRY_FILE}`]: JSON.stringify([
			{ label: "bad-username", origin: "https://app.test", username: {} },
			{ label: "fine", origin: "https://app.test", username: "ada" },
		]),
	});
	const credentials = createKeychainCredentials({
		processes: createFakeProcesses(),
		fs,
		registryPath: `/agent/${CREDENTIAL_REGISTRY_FILE}`,
		platform: "darwin",
	});
	assert.deepEqual(await credentials.list(), [{ label: "fine", origin: "https://app.test", username: "ada" }]);
});

test("duplicate labels collapse to the first entry, because the keychain holds one secret per label", async () => {
	const fs = createFakeFileSystem({
		[`/agent/${CREDENTIAL_REGISTRY_FILE}`]: JSON.stringify([
			{ label: "app-login", origin: "https://app.test" },
			{ label: "app-login", origin: "https://elsewhere.test" },
		]),
	});
	const credentials = createKeychainCredentials({
		processes: createFakeProcesses(),
		fs,
		registryPath: `/agent/${CREDENTIAL_REGISTRY_FILE}`,
		platform: "darwin",
	});
	assert.deepEqual(await credentials.list(), [{ label: "app-login", origin: "https://app.test" }]);
});

test("opaque origins are no origin at all, on the allowlist and on the page alike", async () => {
	// `file:`, `data:`, and custom schemes all serialize their origin to the
	// string "null"; one such allowlist entry would otherwise match every one
	// of those pages, and any credential scoped the same way.
	assert.deepEqual([...parseOriginAllowlist("file:///")], []);
	assert.deepEqual([...parseOriginAllowlist("data:text/html,x")], []);

	const { gate: subject, store } = gate({
		allowlist: new Set(["null"]),
		approve: async () => true,
		entries: [{ label: "app-login", origin: "null", secret: SECRET }],
	});
	const decision = await subject.resolve("app-login", "file:///tmp/login.html");
	assert.equal(decision.ok === false && decision.denial.reason, "origin_not_allowlisted");
	assert.deepEqual(store.reveals, []);
});

test("a keychain lookup that blocks on an unlock prompt is bounded, not awaited forever", async () => {
	// `security` and `secret-tool` wait for a human when the keychain is
	// locked. The capability contract folds an aborted spawn into a non-zero
	// exit, and the timeout makes that happen without anyone at the keyboard.
	const hangingProcesses = {
		kind: "hanging",
		spawn: () => {
			throw new Error("not used");
		},
		exec: (_command: string, _args: readonly string[], options?: { signal?: AbortSignal }) =>
			new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
				options?.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "aborted" }), {
					once: true,
				});
			}),
	};
	const credentials = createKeychainCredentials({
		processes: hangingProcesses as never,
		fs: createFakeFileSystem(),
		registryPath: "/agent/registry.json",
		platform: "darwin",
		lookupTimeoutMs: 25,
	});
	assert.equal(await credentials.reveal("app-login"), undefined, "an unanswerable lookup reads as absent");
});

test("a platform with no keychain CLI reports itself unavailable and reveals nothing", async () => {
	const credentials = createKeychainCredentials({
		processes: createFakeProcesses(),
		fs: createFakeFileSystem(),
		registryPath: "/agent/registry.json",
		platform: "win32",
	});
	assert.equal(credentials.kind, "unavailable");
	assert.equal(keychainLookupCommand("app-login", "win32"), undefined);
	assert.equal(await credentials.reveal("app-login"), undefined);
	assert.deepEqual(await credentials.list(), []);
});

test("an observation is retried a bounded number of times", async () => {
	let attempts = 0;
	const value = await retryObservation(
		async () => {
			attempts += 1;
			if (attempts < 3) throw new Error("transient");
			return "ok";
		},
		{ attempts: 3, sleep: async () => {} },
	);
	assert.equal(value, "ok");
	assert.equal(attempts, 3);

	attempts = 0;
	await assert.rejects(
		retryObservation(
			async () => {
				attempts += 1;
				throw new Error("still failing");
			},
			{ attempts: 2, sleep: async () => {} },
		),
		/still failing/,
	);
	assert.equal(attempts, 2, "retries are bounded, not endless");
});

test("a failed page-changing action reports uncertainty instead of retrying", async () => {
	let calls = 0;
	await assert.rejects(
		runMutating("click", async () => {
			calls += 1;
			throw new Error("socket hung up");
		}),
		(error: unknown) => {
			assert.ok(error instanceof UncertainActionError);
			assert.equal(error.action, "click");
			assert.match(error.message, /effect on the page is unknown/);
			assert.match(error.message, /was not retried/);
			return true;
		},
	);
	assert.equal(calls, 1, "a mutating action is attempted exactly once");
});

test("a login writes the secret into the page and returns only the label", async () => {
	const evaluated: string[] = [];
	const transport = createFakeCdpTransport({
		handlers: {
			"Runtime.evaluate": evaluateHandler((expression) => {
				evaluated.push(expression);
				return true;
			}),
		},
	});
	const client = new CdpClient({ transport });

	const label = await submitLogin(
		client,
		{ label: "app-login", origin: "https://app.test", username: "ada", secret: SECRET },
		{ usernameSelector: "#user", passwordSelector: "#pass", submitSelector: "#go" },
	);

	assert.equal(label, "app-login", "the label is the only part of a credential that comes back");
	assert.ok(!label.includes(SECRET));
	// The secret is in the CDP expression — that is where it is supposed to be —
	// and nowhere in what the caller can render.
	assert.ok(evaluated.some((expression) => expression.includes(SECRET)));
	assert.equal(
		transport.sent.filter((command) => JSON.stringify(command.params ?? {}).includes("#go")).length,
		1,
		"the submit button is clicked once",
	);
});

test("a page that throws the secret back cannot put it into the error message", async () => {
	// The page controls its exception text: an `input` handler can read the
	// field and throw its value. The error the caller sees — and would render
	// into a model-visible tool result — must not carry the secret.
	const transport = createFakeCdpTransport({
		handlers: {
			"Runtime.evaluate": evaluateHandler((expression) => {
				if (expression.includes(SECRET)) throw new Error(`input rejected: ${SECRET} is too weak`);
				return true;
			}),
		},
	});
	const client = new CdpClient({ transport });

	await assert.rejects(
		submitLogin(
			client,
			{ label: "app-login", origin: "https://app.test", secret: SECRET },
			{ passwordSelector: "#pass" },
		),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.ok(!message.includes(SECRET), "the page-authored exception must come back redacted");
			assert.match(message, /\[redacted\]/);
			return true;
		},
	);
});

test("typing into a missing element fails rather than silently doing nothing", async () => {
	const transport = createFakeCdpTransport({ handlers: { "Runtime.evaluate": evaluateHandler(() => false) } });
	const client = new CdpClient({ transport });
	await assert.rejects(typeInto(client, "#absent", "text"), /No element matched #absent/);
});

test("a snapshot is capped and says when it was cut", async () => {
	const long = "x".repeat(500);
	const transport = createFakeCdpTransport({
		handlers: {
			"Runtime.evaluate": evaluateHandler(() => ({ url: "https://app.test/", title: "App", text: long })),
		},
	});
	const client = new CdpClient({ transport });

	const capped = await snapshot(client, { maxChars: 100 });
	assert.equal(capped.text.length, 100);
	assert.equal(capped.truncated, true);
	assert.equal(capped.url, "https://app.test/");
	assert.equal(capped.title, "App");

	const whole = await snapshot(client, { maxChars: 1000 });
	assert.equal(whole.truncated, false);
	assert.equal(whole.text.length, 500);
});

test("a failed navigation leaves no dangling load-event wait to reject later", async () => {
	const transport = createFakeCdpTransport({
		handlers: { "Page.navigate": () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }) },
	});
	// Immediate timers so the load-event timeout fires within this test instead
	// of 30 seconds after it — which is exactly when the old code turned it into
	// an unhandled rejection.
	const client = new CdpClient({
		transport,
		setTimer: (callback, _ms) => {
			const handle = setTimeout(callback, 0);
			return { cancel: () => clearTimeout(handle) };
		},
	});
	const rejections: unknown[] = [];
	const spy = (reason: unknown) => rejections.push(reason);
	process.prependListener("unhandledRejection", spy);
	try {
		await assert.rejects(
			navigate(client, "https://nope.invalid/"),
			/Navigation .* failed: net::ERR_NAME_NOT_RESOLVED/,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(rejections, [], "the load-event wait must be settled or swallowed, never orphaned");
	} finally {
		process.removeListener("unhandledRejection", spy);
	}
});
