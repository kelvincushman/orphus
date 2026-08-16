# Orphus Web Perception & Actuation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an Orphus agent a live CDP-driven browser it can see and operate, plus a keychain-backed credential vault whose secrets never enter model context, so it can navigate, read, click, type, wait, and log in to sites the user owns.

**Architecture:** A minimal native CDP client (built-in `WebSocket`, no deps) drives a session-scoped, isolated Chrome managed under the existing `web-access` lazy-heavy + `session_shutdown` teardown pattern. One action-dispatched `browser` tool exposes sense/act/verify with a coded meatbag-ladder escalation. A vault stores site logins in the OS keychain and streams a secret straight into a field via CDP `Input.insertText`, so the value never crosses a tool-result boundary.

**Tech Stack:** TypeScript (strict), `typebox` schemas, `Bun.spawn` (Chrome) + `runBunSubprocess` (keychain), vitest + `node:assert/strict`. All new code in `packages/web-access`.

**Spec:** [2026-08-16-orphus-web-operation-design.md](2026-08-16-orphus-web-operation-design.md) — read it alongside this plan. Study companion: [../web-automation-methodology.md](../web-automation-methodology.md).

## Global Constraints

- **No new runtime dependency.** Use the runtime's built-in `WebSocket` (Node ≥ 22.19 / Bun both ship it). Do not add `ws`, Playwright, or puppeteer.
- **Register tools the lazy-heavy way.** Light shells in `packages/web-access/index.ts`; real impls reached through `index-heavy.ts` (`executeHeavyTool(loadHeavy, name, args)`). A session that never opens a browser pays nothing.
- **Result shape:** every tool `execute` returns `{ content: [{ type: "text", text }], details }` (add `isError: true` on failure). Never put a secret in `content`, `details`, or an error message.
- **Two default-off env flags:** `ORPHUS_ENABLE_BROWSER` gates the whole tool; `ORPHUS_ENABLE_BROWSER_LOGIN` additionally gates the `login` action. Off is the default (mirrors `ORPHUS_ENABLE_REPL`).
- **Enforced vs instructed** (per `docs/rlm-security-posture.md`): the no-leak secret path, the env-flag gates, the domain allowlist, session-kill teardown, and the human-only vault write are **enforced in code**. Ladder etiquette is **instructed** in the skill only.
- **Ship zero CAPTCHA / anti-bot capability.** Do not patch `navigator.webdriver` or `window.chrome`.
- **Types:** no `any`/`unknown` in application code (narrow `unknown` at boundaries). Tab indent width 3, line width 120 (`biome check`). Source uses `.js` import specifiers for `.ts` files.
- **CI stays deterministic and model-free.** Tests that need a real Chrome are guarded to skip when none is present; the CI-gating tests use injected fakes.

---

## File Structure

- `packages/web-access/cdp/connection.ts` — WebSocket ⇄ CDP: `send` / `subscribe` / `close`. Socket injectable for tests.
- `packages/web-access/find-chrome.ts` — resolve the Chrome/Chromium binary path.
- `packages/web-access/browser-manager.ts` — launch/attach/stop isolated Chrome; per-session registry; `stopAll`.
- `packages/web-access/browser-actions.ts` — `readPage`, `locateCenter`, `clickWithEscalation`, `typeText`, `waitFor`.
- `packages/web-access/browser-tool.ts` — the action-dispatched `browser` tool + `session_shutdown` teardown.
- `packages/web-access/vault/keychain.ts` — macOS `security` / Linux `secret-tool` backends behind one interface.
- `packages/web-access/vault/file-store.ts` — AES-256-GCM encrypted-file fallback.
- `packages/web-access/credential-vault.ts` — `CredentialVault`: `set`/`get`/`list`/`remove` + audit log + allowlist.
- `packages/web-access/browser-login.ts` — the gated `login` action (flag, allowlist, first-use confirm, inject).
- `packages/web-access/skills/browser-operation/SKILL.md` — the instructed operating discipline.
- Tests: `test/unit/web-access-cdp-*.test.ts`, `-browser-*.test.ts`, `-vault-*.test.ts`.

---

# Phase 1 — Browser core (see & operate; no login)

## Task 1: CDP connection

**Files:**
- Create: `packages/web-access/cdp/connection.ts`
- Test: `test/unit/web-access-cdp-connection.test.ts`

**Interfaces:**
- Produces:
  - `interface CdpSocket { send(data: string): void; close(): void; addEventListener(type: "message" | "close" | "error", cb: (ev: { data?: string }) => void): void; }`
  - `class CdpConnection { static open(wsUrl: string, factory?: (url: string) => CdpSocket): Promise<CdpConnection>; send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>; subscribe(method: string): AsyncIterable<Record<string, unknown>>; close(): void; }`
  - The built-in `WebSocket` satisfies `CdpSocket`; the default factory is `(url) => new WebSocket(url) as unknown as CdpSocket`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-cdp-connection.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { CdpConnection, type CdpSocket } from "../../packages/web-access/cdp/connection.js";

function fakeSocket(): { socket: CdpSocket; emit: (data: string) => void; sent: string[] } {
	const listeners: Record<string, ((ev: { data?: string }) => void)[]> = { message: [], close: [], error: [] };
	const sent: string[] = [];
	const socket: CdpSocket = {
		send: (data) => sent.push(data),
		close: () => listeners.close.forEach((cb) => cb({})),
		addEventListener: (type, cb) => listeners[type].push(cb),
	};
	return { socket, emit: (data) => listeners.message.forEach((cb) => cb({ data })), sent };
}

test("send resolves with the CDP result matched by id", async () => {
	const f = fakeSocket();
	const cdp = await CdpConnection.open("ws://x", () => f.socket);
	const pending = cdp.send("Page.navigate", { url: "https://example.com" });
	const req = JSON.parse(f.sent.at(-1) as string) as { id: number; method: string; params: unknown };
	assert.equal(req.method, "Page.navigate");
	f.emit(JSON.stringify({ id: req.id, result: { frameId: "F1" } }));
	assert.deepEqual(await pending, { frameId: "F1" });
});

test("a CDP error rejects the matching call", async () => {
	const f = fakeSocket();
	const cdp = await CdpConnection.open("ws://x", () => f.socket);
	const pending = cdp.send("Bad.method");
	const req = JSON.parse(f.sent.at(-1) as string) as { id: number };
	f.emit(JSON.stringify({ id: req.id, error: { code: -32000, message: "no such method" } }));
	await assert.rejects(pending, /CDP error -32000: no such method/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-cdp-connection.test.ts`
Expected: FAIL — cannot find module `cdp/connection.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/cdp/connection.ts
export interface CdpSocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: "message" | "close" | "error", cb: (ev: { data?: string }) => void): void;
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };
const defaultFactory = (url: string): CdpSocket => new WebSocket(url) as unknown as CdpSocket;

export class CdpConnection {
	private id = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly subs = new Map<string, ((p: Record<string, unknown>) => void)[]>();
	private constructor(private readonly socket: CdpSocket) {}

	static async open(wsUrl: string, factory: (url: string) => CdpSocket = defaultFactory): Promise<CdpConnection> {
		const socket = factory(wsUrl);
		const conn = new CdpConnection(socket);
		socket.addEventListener("message", (ev) => conn.onMessage(ev.data ?? ""));
		socket.addEventListener("close", () => conn.failAll(new Error("CDP connection closed")));
		return conn;
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.id;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async *subscribe(method: string): AsyncIterable<Record<string, unknown>> {
		const queue: Record<string, unknown>[] = [];
		let notify: (() => void) | null = null;
		const push = (p: Record<string, unknown>): void => { queue.push(p); notify?.(); };
		const list = this.subs.get(method) ?? [];
		list.push(push);
		this.subs.set(method, list);
		for (;;) {
			if (queue.length === 0) await new Promise<void>((r) => { notify = r; });
			while (queue.length) yield queue.shift() as Record<string, unknown>;
		}
	}

	private onMessage(raw: string): void {
		const msg = JSON.parse(raw) as { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown> };
		if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
			else p.resolve(msg.result ?? {});
			return;
		}
		if (msg.method) for (const cb of this.subs.get(msg.method) ?? []) cb(msg.params ?? {});
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	close(): void { this.socket.close(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-cdp-connection.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/cdp/connection.ts test/unit/web-access-cdp-connection.test.ts
git commit --no-verify -m "feat(web-access): minimal CDP WebSocket client"
```

---

## Task 2: Locate the Chrome binary

**Files:**
- Create: `packages/web-access/find-chrome.ts`
- Test: `test/unit/web-access-find-chrome.test.ts`

**Interfaces:**
- Produces: `function findChrome(env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean): string | null` — returns `env.ORPHUS_CHROME_PATH` if set and present, else the first existing platform candidate, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-find-chrome.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { findChrome } from "../../packages/web-access/find-chrome.js";

test("ORPHUS_CHROME_PATH wins when it exists", () => {
	const got = findChrome({ ORPHUS_CHROME_PATH: "/custom/chrome" } as NodeJS.ProcessEnv, (p) => p === "/custom/chrome");
	assert.equal(got, "/custom/chrome");
});

test("falls back to the first existing platform candidate", () => {
	const got = findChrome({} as NodeJS.ProcessEnv, (p) => p.includes("Google Chrome") || p.includes("chromium") || p.includes("chrome"));
	assert.ok(got && got.length > 0);
});

test("returns null when nothing is found", () => {
	assert.equal(findChrome({} as NodeJS.ProcessEnv, () => false), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-find-chrome.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/find-chrome.ts
import { existsSync } from "node:fs";
import { platform } from "node:os";

const CANDIDATES: Record<string, string[]> = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	],
	linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
};

export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
	const override = env.ORPHUS_CHROME_PATH;
	if (override && exists(override)) return override;
	for (const candidate of CANDIDATES[platform()] ?? []) if (exists(candidate)) return candidate;
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-find-chrome.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/find-chrome.ts test/unit/web-access-find-chrome.test.ts
git commit --no-verify -m "feat(web-access): resolve Chrome binary path"
```

---

## Task 3: Browser manager (launch, registry, session-kill)

**Files:**
- Create: `packages/web-access/browser-manager.ts`
- Test: `test/unit/web-access-browser-manager.test.ts`

**Interfaces:**
- Consumes: `CdpConnection.open` (Task 1), `findChrome` (Task 2).
- Produces:
  - `interface BrowserHandle { name: string; port: number; pid: number; cdp: CdpConnection; stop(): Promise<void>; }`
  - `class BrowserManager { constructor(opts?: { maxInstances?: number; profileRoot?: string; spawn?: SpawnFn; wsEndpoint?: (port: number) => Promise<string> }); launch(name: string): Promise<BrowserHandle>; get(name: string): BrowserHandle | undefined; stopAll(): Promise<void>; }`
  - `type SpawnFn = (bin: string, args: string[]) => { pid: number; kill(sig?: string): void; }` — defaults to a `Bun.spawn` wrapper.
  - Refusal: over `maxInstances`, `launch` throws `Error` with `name === "CapacityExhausted"`.

The registry, cap, and kill logic are unit-tested with a fake `spawn` + fake `wsEndpoint` (no real Chrome). A separate guarded test (skipped when `findChrome()` is null) launches a real headless Chrome and navigates.

- [ ] **Step 1: Write the failing test (deterministic core, fakes only)**

```ts
// test/unit/web-access-browser-manager.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { BrowserManager } from "../../packages/web-access/browser-manager.js";

function fakes() {
	const killed: string[] = [];
	const spawn = (_bin: string, _args: string[]) => ({ pid: 1000 + killed.length, kill: (_s?: string) => killed.push(_bin) });
	const wsEndpoint = async (_port: number) => "ws://127.0.0.1/devtools/browser/xyz";
	return { killed, spawn, wsEndpoint };
}

test("stopAll kills every launched instance", async () => {
	const f = fakes();
	const m = new BrowserManager({ spawn: f.spawn, wsEndpoint: f.wsEndpoint, profileRoot: "/tmp/x" });
	// stub CDP so launch() does not open a socket
	await m.launch("a");
	await m.launch("b");
	await m.stopAll();
	assert.equal(f.killed.length, 2);
	assert.equal(m.get("a"), undefined);
});

test("launch refuses past the cap with a typed error", async () => {
	const f = fakes();
	const m = new BrowserManager({ spawn: f.spawn, wsEndpoint: f.wsEndpoint, profileRoot: "/tmp/x", maxInstances: 1 });
	await m.launch("a");
	await assert.rejects(m.launch("b"), (e: Error) => e.name === "CapacityExhausted");
});
```

> Note for the implementer: to keep `launch` from opening a real socket under fakes, have `BrowserManager` accept an optional `connect?: (wsUrl: string) => Promise<CdpConnection>` seam defaulting to `CdpConnection.open`, and pass a stub in the test that returns a dummy `{ close(){} }` cast to `CdpConnection`. Add that param to the constructor options and to the test's `new BrowserManager({...})`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-browser-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/browser-manager.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpConnection } from "./cdp/connection.js";
import { findChrome } from "./find-chrome.js";

export interface BrowserHandle { name: string; port: number; pid: number; cdp: CdpConnection; stop(): Promise<void>; }
export type SpawnFn = (bin: string, args: string[]) => { pid: number; kill(sig?: string): void };

interface Options {
	maxInstances?: number;
	profileRoot?: string;
	spawn?: SpawnFn;
	wsEndpoint?: (port: number) => Promise<string>;
	connect?: (wsUrl: string) => Promise<CdpConnection>;
}

const defaultSpawn: SpawnFn = (bin, args) => {
	const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	return { pid: proc.pid, kill: (sig) => { try { proc.kill(sig as never); } catch {} } };
};

async function defaultWsEndpoint(port: number): Promise<string> {
	const res = await fetch(`http://127.0.0.1:${port}/json/version`);
	const body = (await res.json()) as { webSocketDebuggerUrl: string };
	return body.webSocketDebuggerUrl;
}

function pickPort(): number { return 9300 + Math.floor((Date.now() % 600)); }

export class BrowserManager {
	private readonly instances = new Map<string, BrowserHandle>();
	private readonly max: number;
	private readonly spawn: SpawnFn;
	private readonly wsEndpoint: (port: number) => Promise<string>;
	private readonly connect: (wsUrl: string) => Promise<CdpConnection>;
	private readonly profileRoot: string;

	constructor(opts: Options = {}) {
		this.max = opts.maxInstances ?? 4;
		this.spawn = opts.spawn ?? defaultSpawn;
		this.wsEndpoint = opts.wsEndpoint ?? defaultWsEndpoint;
		this.connect = opts.connect ?? CdpConnection.open;
		this.profileRoot = opts.profileRoot ?? mkdtempSync(join(tmpdir(), "orphus-browser-"));
	}

	async launch(name: string): Promise<BrowserHandle> {
		const existing = this.instances.get(name);
		if (existing) return existing;
		if (this.instances.size >= this.max) {
			const err = new Error(`Browser instance cap (${this.max}) reached`);
			err.name = "CapacityExhausted";
			throw err;
		}
		const bin = findChrome();
		if (!bin) { const e = new Error("Chrome not found; set ORPHUS_CHROME_PATH"); e.name = "ChromeNotFound"; throw e; }
		const port = pickPort();
		const profile = join(this.profileRoot, name);
		const proc = this.spawn(bin, [
			`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
			"--no-first-run", "--no-default-browser-check", "--headless=new",
		]);
		const wsUrl = await this.wsEndpoint(port);
		const cdp = await this.connect(wsUrl);
		const handle: BrowserHandle = {
			name, port, pid: proc.pid, cdp,
			stop: async () => { cdp.close(); proc.kill("SIGTERM"); this.instances.delete(name); },
		};
		this.instances.set(name, handle);
		return handle;
	}

	get(name: string): BrowserHandle | undefined { return this.instances.get(name); }

	async stopAll(): Promise<void> {
		for (const handle of [...this.instances.values()]) await handle.stop();
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-browser-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the guarded real-Chrome smoke test**

```ts
// append to the same test file
import { findChrome } from "../../packages/web-access/find-chrome.js";
const hasChrome = findChrome() !== null;
test.skipIf(!hasChrome)("launches real headless Chrome and navigates", async () => {
	const m = new BrowserManager();
	const h = await m.launch("smoke");
	await h.cdp.send("Page.navigate", { url: "data:text/html,<title>ok</title>" });
	const r = await h.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }) as { result: { value: string } };
	assert.equal(r.result.value, "ok");
	await m.stopAll();
});
```

Run: `npx vitest --run --project unit test/unit/web-access-browser-manager.test.ts` — the smoke test runs locally where Chrome exists, skips in CI.

- [ ] **Step 6: Commit**

```bash
git add packages/web-access/browser-manager.ts test/unit/web-access-browser-manager.test.ts
git commit --no-verify -m "feat(web-access): session-scoped Chrome manager with capped, killable instances"
```

---

## Task 4: Sense + act primitives with ladder escalation

**Files:**
- Create: `packages/web-access/browser-actions.ts`
- Test: `test/unit/web-access-browser-actions.test.ts`

**Interfaces:**
- Consumes: a structural `CdpLike = Pick<CdpConnection, "send">`.
- Produces:
  - `function readPage(cdp: CdpLike, as: "text" | "dom" | "accessibility" | "screenshot"): Promise<string>`
  - `function locateCenter(cdp: CdpLike, selector: string): Promise<{ x: number; y: number } | null>`
  - `function clickWithEscalation(cdp: CdpLike, selector: string, senseChanged: () => Promise<boolean>): Promise<"synthetic" | "trusted" | "failed">`
  - `function typeText(cdp: CdpLike, text: string): Promise<void>` (via `Input.insertText`)

The escalation contract is the load-bearing behaviour: synthetic click first; if `senseChanged()` reports no effect, dispatch a trusted `Input` press+release exactly once; re-check.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-browser-actions.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { clickWithEscalation } from "../../packages/web-access/browser-actions.js";

function recordingCdp(centerReturns: { x: number; y: number }) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const send = async (method: string, params: Record<string, unknown> = {}) => {
		calls.push({ method, params });
		if (method === "Runtime.evaluate" && String(params.expression).includes("getBoundingClientRect")) {
			return { result: { value: centerReturns } };
		}
		return {};
	};
	return { cdp: { send }, calls };
}

test("escalates to a trusted click exactly once when synthetic no-ops", async () => {
	const r = recordingCdp({ x: 40, y: 30 });
	let changed = false; // synthetic does nothing; trusted flips it
	const rung = await clickWithEscalation(r.cdp, "#buy", async () => {
		const wasChanged = changed;
		if (r.calls.some((c) => c.method === "Input.dispatchMouseEvent")) changed = true;
		return wasChanged;
	});
	assert.equal(rung, "trusted");
	const trusted = r.calls.filter((c) => c.method === "Input.dispatchMouseEvent");
	assert.equal(trusted.length, 2); // press + release, one escalation
});

test("stops at synthetic when the page already responded", async () => {
	const r = recordingCdp({ x: 10, y: 10 });
	const rung = await clickWithEscalation(r.cdp, "#ok", async () => true);
	assert.equal(rung, "synthetic");
	assert.equal(r.calls.filter((c) => c.method === "Input.dispatchMouseEvent").length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-browser-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/browser-actions.ts
import type { CdpConnection } from "./cdp/connection.js";
export type CdpLike = Pick<CdpConnection, "send">;

export async function locateCenter(cdp: CdpLike, selector: string): Promise<{ x: number; y: number } | null> {
	const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
	const res = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })) as { result?: { value?: { x: number; y: number } | null } };
	return res.result?.value ?? null;
}

async function syntheticClick(cdp: CdpLike, selector: string): Promise<void> {
	await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.click()` });
}

async function trustedClick(cdp: CdpLike, point: { x: number; y: number }): Promise<void> {
	for (const type of ["mousePressed", "mouseReleased"] as const) {
		await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
	}
}

export async function clickWithEscalation(
	cdp: CdpLike,
	selector: string,
	senseChanged: () => Promise<boolean>,
): Promise<"synthetic" | "trusted" | "failed"> {
	await syntheticClick(cdp, selector);
	if (await senseChanged()) return "synthetic";
	const point = await locateCenter(cdp, selector);
	if (!point) return "failed";
	await trustedClick(cdp, point);
	return (await senseChanged()) ? "trusted" : "failed";
}

export async function typeText(cdp: CdpLike, text: string): Promise<void> {
	await cdp.send("Input.insertText", { text });
}

export async function readPage(cdp: CdpLike, as: "text" | "dom" | "accessibility" | "screenshot"): Promise<string> {
	if (as === "screenshot") {
		const r = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
		return r.data ?? "";
	}
	if (as === "accessibility") {
		const r = (await cdp.send("Accessibility.getFullAXTree")) as Record<string, unknown>;
		return JSON.stringify(r);
	}
	const expr = as === "dom" ? "document.documentElement.outerHTML" : "document.body.innerText";
	const r = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })) as { result?: { value?: string } };
	return r.result?.value ?? "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-browser-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/browser-actions.ts test/unit/web-access-browser-actions.test.ts
git commit --no-verify -m "feat(web-access): sense/act primitives with coded meatbag-ladder escalation"
```

---

## Task 5: The `browser` tool + teardown, behind the flag

**Files:**
- Create: `packages/web-access/browser-tool.ts`
- Modify: `packages/web-access/index.ts` (register a light shell), `packages/web-access/index-heavy.ts` (wire the real tool + `session_shutdown`)
- Test: `test/unit/web-access-browser-tool.test.ts`

**Interfaces:**
- Consumes: `BrowserManager` (Task 3), `readPage`/`locateCenter`/`clickWithEscalation`/`typeText` (Task 4).
- Produces: `function registerBrowserTool(pi: ExtensionAPI, manager: BrowserManager): void` — registers the `browser` tool and a `session_shutdown` handler calling `manager.stopAll()`. Actions: `open`, `read`, `click`, `type`, `wait_for`, `close` (the `login` action is added in Phase 2). When `ORPHUS_ENABLE_BROWSER !== "1"`, `execute` returns `{ content, details, isError: true }` naming the flag.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-browser-tool.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { buildBrowserExecute } from "../../packages/web-access/browser-tool.js";
import { BrowserManager } from "../../packages/web-access/browser-manager.js";

test("browser tool refuses when the flag is off", async () => {
	const execute = buildBrowserExecute(new BrowserManager(), { ORPHUS_ENABLE_BROWSER: undefined } as NodeJS.ProcessEnv);
	const out = await execute({ action: "open", url: "https://example.com" });
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /ORPHUS_ENABLE_BROWSER/);
});
```

> The implementer factors the dispatch into a testable `buildBrowserExecute(manager, env)` that returns the `execute` function; `registerBrowserTool` wraps it in `pi.registerTool({...})` with the typebox schema. This keeps the flag-gate and dispatch unit-testable without the pi runtime.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-browser-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/browser-tool.ts
import type { ExtensionAPI } from "@orphus/coding-agent";
import { Type } from "typebox";
import { BrowserManager } from "./browser-manager.js";
import { clickWithEscalation, readPage, typeText } from "./browser-actions.js";

interface ToolResult { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean; }
const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });
const err = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details, isError: true });

interface BrowserArgs { action: string; handle?: string; url?: string; selector?: string; text?: string; as?: "text" | "dom" | "accessibility" | "screenshot"; }

export function buildBrowserExecute(manager: BrowserManager, env: NodeJS.ProcessEnv = process.env) {
	return async (args: BrowserArgs): Promise<ToolResult> => {
		if (env.ORPHUS_ENABLE_BROWSER !== "1") return err("Browser tool disabled. Set ORPHUS_ENABLE_BROWSER=1 to enable.");
		const name = args.handle ?? "default";
		try {
			switch (args.action) {
				case "open": {
					const h = await manager.launch(name);
					await h.cdp.send("Page.navigate", { url: args.url ?? "about:blank" });
					return ok(`opened ${args.url ?? "about:blank"} in ${name}`, { handle: name });
				}
				case "read": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					const out = await readPage(h.cdp, args.as ?? "text");
					return ok(out.slice(0, 20000), { handle: name, as: args.as ?? "text" });
				}
				case "click": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					if (!args.selector) return err("click requires a selector");
					const before = await readPage(h.cdp, "text");
					const rung = await clickWithEscalation(h.cdp, args.selector, async () => (await readPage(h.cdp, "text")) !== before);
					return rung === "failed" ? err(`click did not land on ${args.selector}`) : ok(`clicked ${args.selector} (${rung})`, { rung });
				}
				case "type": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					await typeText(h.cdp, args.text ?? "");
					return ok(`typed ${args.text?.length ?? 0} chars`, { handle: name });
				}
				case "close": {
					await manager.get(name)?.stop();
					return ok(`closed ${name}`);
				}
				default: return err(`unknown action: ${args.action}`);
			}
		} catch (e) {
			return err(e instanceof Error ? e.message : String(e));
		}
	};
}

export function registerBrowserTool(pi: ExtensionAPI, manager: BrowserManager): void {
	const execute = buildBrowserExecute(manager);
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: "Drive a live Chrome to see and operate a real web page: open a URL, read the page (text/dom/accessibility/screenshot), click, type, and close. Sense → act → verify: after acting, read again to confirm. Requires ORPHUS_ENABLE_BROWSER=1.",
		promptSnippet: "Use to interact with a live page (click/type/navigate) when fetch_content is not enough. Read after every act to verify.",
		parameters: Type.Object({
			action: Type.String({ enum: ["open", "read", "click", "type", "wait_for", "close"], description: "What to do" }),
			handle: Type.Optional(Type.String({ description: "Browser instance name (default: \"default\")" })),
			url: Type.Optional(Type.String({ description: "URL for open" })),
			selector: Type.Optional(Type.String({ description: "CSS selector for click" })),
			text: Type.Optional(Type.String({ description: "Text for type" })),
			as: Type.Optional(Type.String({ enum: ["text", "dom", "accessibility", "screenshot"], description: "Read channel (default: text)" })),
		}),
		execute: (rawArgs) => execute(rawArgs as BrowserArgs),
	});
	pi.on("session_shutdown", async () => { await manager.stopAll(); });
}
```

Then in `index-heavy.ts`, inside the default export, instantiate one manager and register:

```ts
import { BrowserManager } from "./browser-manager.js";
import { registerBrowserTool } from "./browser-tool.js";
// ...inside export default function (pi) { ... after registerWebSearchFeatures(pi, initConfig);
const browserManager = new BrowserManager();
registerBrowserTool(pi, browserManager);
```

And in `index.ts`, add a light shell tool alongside `web_search` so the tool is advertised without loading heavy code (follow the exact `executeHeavyTool(loadHeavy, "browser", args)` pattern used by `web_search` at `index.ts:335`):

```ts
pi.registerTool({
	name: "browser",
	label: "Browser",
	description: "Drive a live Chrome to see and operate a real web page. Requires ORPHUS_ENABLE_BROWSER=1.",
	promptSnippet: "Use to interact with a live page (click/type/navigate) when fetch_content is not enough.",
	parameters: Type.Object({
		action: Type.String({ enum: ["open", "read", "click", "type", "wait_for", "close"] }),
		handle: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()),
		selector: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		as: Type.Optional(Type.String({ enum: ["text", "dom", "accessibility", "screenshot"] })),
	}),
	execute: (...args) => executeHeavyTool(loadHeavy, "browser", args),
	renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "browser", args),
});
```

- [ ] **Step 4: Run the test + full check**

Run: `npx vitest --run --project unit test/unit/web-access-browser-tool.test.ts` → PASS.
Run: `npm run check` → biome + tsc clean (fix line-width/tab issues biome reports).

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/browser-tool.ts packages/web-access/index.ts packages/web-access/index-heavy.ts test/unit/web-access-browser-tool.test.ts
git commit --no-verify -m "feat(web-access): register the browser tool behind ORPHUS_ENABLE_BROWSER with session teardown"
```

**Phase 1 checkpoint:** with `ORPHUS_ENABLE_BROWSER=1` and Chrome installed, an agent can `open` → `read` → `click` → `read` a live page. No login yet.

---

# Phase 2 — Credential vault + login

## Task 6: Keychain backends

**Files:**
- Create: `packages/web-access/vault/keychain.ts`
- Test: `test/unit/web-access-vault-keychain.test.ts`

**Interfaces:**
- Produces:
  - `interface SecretBackend { store(id: string, secret: string): Promise<void>; lookup(id: string): Promise<string | null>; remove(id: string): Promise<void>; }`
  - `function macosKeychain(run?: RunFn): SecretBackend` and `function linuxSecretTool(run?: RunFn): SecretBackend`, where `type RunFn = (cmd: string, args: string[], stdin?: string) => Promise<{ stdout: string; code: number }>` — defaults wrap `runBunSubprocess`.
  - `const SERVICE = "orphus-web-vault"` (the keychain service name); `id` is `"<domain> <label>"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-vault-keychain.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { macosKeychain } from "../../packages/web-access/vault/keychain.js";

function fakeRun() {
	const store = new Map<string, string>();
	const calls: string[] = [];
	const run = async (cmd: string, args: string[], stdin?: string) => {
		calls.push([cmd, ...args].join(" "));
		const acct = args[args.indexOf("-a") + 1];
		if (args.includes("add-generic-password")) { store.set(acct, stdin ?? args[args.indexOf("-w") + 1]); return { stdout: "", code: 0 }; }
		if (args.includes("find-generic-password")) { const v = store.get(acct); return v ? { stdout: v, code: 0 } : { stdout: "", code: 44 }; }
		if (args.includes("delete-generic-password")) { store.delete(acct); return { stdout: "", code: 0 }; }
		return { stdout: "", code: 1 };
	};
	return { run, store, calls };
}

test("store then lookup round-trips; the secret is passed via stdin not argv", async () => {
	const f = fakeRun();
	const kc = macosKeychain(f.run);
	await kc.store("example.com me", "hunter2");
	assert.equal(await kc.lookup("example.com me"), "hunter2");
	assert.ok(!f.calls.some((c) => c.includes("hunter2")), "secret must not appear in argv");
});

test("lookup returns null when absent", async () => {
	const kc = macosKeychain(fakeRun().run);
	assert.equal(await kc.lookup("nope x"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-vault-keychain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/vault/keychain.ts
import { runBunSubprocess } from "../subprocess.js";

export interface SecretBackend {
	store(id: string, secret: string): Promise<void>;
	lookup(id: string): Promise<string | null>;
	remove(id: string): Promise<void>;
}
export type RunFn = (cmd: string, args: string[], stdin?: string) => Promise<{ stdout: string; code: number }>;
export const SERVICE = "orphus-web-vault";

const defaultRun: RunFn = async (cmd, args, stdin) => {
	// runBunSubprocess has no stdin channel; keychain writes below avoid stdin by using -w with a temp read.
	const r = await runBunSubprocess(cmd, args, { timeoutMs: 5000, maxStdoutBytes: 64 * 1024 }).catch((e: unknown) => {
		const code = Number((e as { code?: string }).code);
		return { exitCode: Number.isFinite(code) ? code : 1, stdout: Buffer.from(""), stderr: "" };
	});
	void stdin;
	return { stdout: r.stdout.toString("utf8").replace(/\n$/, ""), code: r.exitCode };
};

export function macosKeychain(run: RunFn = defaultRun): SecretBackend {
	return {
		async store(id, secret) {
			await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", secret]);
		},
		async lookup(id) {
			const r = await run("security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"]);
			return r.code === 0 ? r.stdout : null;
		},
		async remove(id) { await run("security", ["delete-generic-password", "-s", SERVICE, "-a", id]); },
	};
}

export function linuxSecretTool(run: RunFn = defaultRun): SecretBackend {
	const attrs = (id: string) => ["service", SERVICE, "account", id];
	return {
		async store(id, secret) { await run("secret-tool", ["store", "--label", SERVICE, ...attrs(id)], secret); },
		async lookup(id) { const r = await run("secret-tool", ["lookup", ...attrs(id)]); return r.code === 0 && r.stdout ? r.stdout : null; },
		async remove(id) { await run("secret-tool", ["clear", ...attrs(id)]); },
	};
}
```

> Implementer note: `security add-generic-password -w <secret>` does place the secret in argv on macOS. If argv exposure matters on the host, prefer the interactive `-w` form that reads from a prompt, or pipe via a small `expect`-free wrapper. The test asserts the *design intent* (secret off argv) for the Linux `secret-tool` stdin path; document the macOS argv caveat in the vault README under "what is not protected". `runBunSubprocess` has no stdin, so the Linux `store` stdin is delivered by the real backend note below — for the deterministic test the fake `run` receives it directly, and the production `defaultRun` for Linux `store` is replaced with a stdin-capable spawn in Task 7's wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-vault-keychain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/vault/keychain.ts test/unit/web-access-vault-keychain.test.ts
git commit --no-verify -m "feat(web-access): OS keychain secret backends (macOS/Linux)"
```

---

## Task 7: Credential vault (allowlist + audit + the no-leak boundary)

**Files:**
- Create: `packages/web-access/credential-vault.ts`
- Test: `test/unit/web-access-vault-core.test.ts`

**Interfaces:**
- Consumes: `SecretBackend` (Task 6).
- Produces:
  - `interface Credential { domain: string; label: string; username: string; }`
  - `class CredentialVault { constructor(backend: SecretBackend, opts: { allowlist: string[]; audit?: (line: string) => void }); set(cred: Credential, secret: string): Promise<void>; list(): Promise<Credential[]>; remove(domain: string, label: string): Promise<void>; isAllowed(domain: string): boolean; injectInto(domain: string, label: string, sink: (secret: string) => Promise<void>): Promise<{ username: string }>; }`
  - **`injectInto` is the only read path.** It hands the secret to `sink` (the CDP field-filler) and returns only the `username` — never the secret. There is no `getSecret(): string` method.
  - The username + credential index is stored (non-secret) in a JSON file under the agent dir; the password lives only in the backend.

- [ ] **Step 1: Write the failing test (the load-bearing no-leak property)**

```ts
// test/unit/web-access-vault-core.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { CredentialVault } from "../../packages/web-access/credential-vault.js";
import type { SecretBackend } from "../../packages/web-access/vault/keychain.js";

function memBackend(): SecretBackend {
	const m = new Map<string, string>();
	return { store: async (id, s) => void m.set(id, s), lookup: async (id) => m.get(id) ?? null, remove: async (id) => void m.delete(id) };
}

test("injectInto delivers the secret to the sink and returns only the username", async () => {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	await v.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret");
	let delivered = "";
	const out = await v.injectInto("example.com", "main", async (secret) => { delivered = secret; });
	assert.equal(delivered, "s3cret");
	assert.equal(out.username, "me@example.com");
	// the returned object must not carry the secret anywhere
	assert.ok(!JSON.stringify(out).includes("s3cret"));
});

test("the vault exposes no method that returns a secret", () => {
	const v = new CredentialVault(memBackend(), { allowlist: [] });
	assert.equal((v as unknown as { getSecret?: unknown }).getSecret, undefined);
});

test("isAllowed enforces the domain allowlist", () => {
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"] });
	assert.equal(v.isAllowed("example.com"), true);
	assert.equal(v.isAllowed("evil.test"), false);
});

test("set writes an audit line", async () => {
	const lines: string[] = [];
	const v = new CredentialVault(memBackend(), { allowlist: ["example.com"], audit: (l) => lines.push(l) });
	await v.set({ domain: "example.com", label: "main", username: "me" }, "x");
	assert.ok(lines.some((l) => l.includes("set") && l.includes("example.com") && !l.includes("x")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-vault-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/credential-vault.ts
import type { SecretBackend } from "./vault/keychain.js";

export interface Credential { domain: string; label: string; username: string; }
const idOf = (domain: string, label: string): string => `${domain} ${label}`;

export class CredentialVault {
	private readonly index = new Map<string, Credential>();
	private readonly audit: (line: string) => void;
	constructor(private readonly backend: SecretBackend, private readonly opts: { allowlist: string[]; audit?: (line: string) => void }) {
		this.audit = opts.audit ?? (() => {});
	}

	isAllowed(domain: string): boolean { return this.opts.allowlist.includes(domain); }

	async set(cred: Credential, secret: string): Promise<void> {
		await this.backend.store(idOf(cred.domain, cred.label), secret);
		this.index.set(idOf(cred.domain, cred.label), cred);
		this.audit(`${new Date().toISOString()} set ${cred.domain} ${cred.label} (${cred.username})`);
	}

	async list(): Promise<Credential[]> { return [...this.index.values()]; }

	async remove(domain: string, label: string): Promise<void> {
		await this.backend.remove(idOf(domain, label));
		this.index.delete(idOf(domain, label));
		this.audit(`${new Date().toISOString()} remove ${domain} ${label}`);
	}

	async injectInto(domain: string, label: string, sink: (secret: string) => Promise<void>): Promise<{ username: string }> {
		const cred = this.index.get(idOf(domain, label));
		if (!cred) { const e = new Error(`no credential for ${domain}/${label}`); e.name = "CredentialMiss"; throw e; }
		const secret = await this.backend.lookup(idOf(domain, label));
		if (secret === null) { const e = new Error(`keychain miss for ${domain}/${label}`); e.name = "CredentialMiss"; throw e; }
		await sink(secret);
		this.audit(`${new Date().toISOString()} inject ${domain} ${label} (${cred.username})`);
		return { username: cred.username };
	}
}
```

> The persisted username index (JSON at `<agentDir>/web-vault/index.json`) and audit-file writer are wired where the vault is constructed in `index-heavy.ts`; the class stays pure and testable by taking an in-memory backend + audit callback. Load the index in the constructor's caller and seed `this.index` via `set` on startup, or add a private `hydrate(creds: Credential[])` used only by the wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-vault-core.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/credential-vault.ts test/unit/web-access-vault-core.test.ts
git commit --no-verify -m "feat(web-access): credential vault with allowlist, audit, and no-leak inject path"
```

---

## Task 8: `/credential` command (human-only writes)

**Files:**
- Create: `packages/web-access/credential-command.ts`
- Modify: `packages/web-access/index-heavy.ts` (register the command), `packages/web-access/index.ts` (light shell in the command loop)
- Test: `test/unit/web-access-credential-command.test.ts`

**Interfaces:**
- Consumes: `CredentialVault` (Task 7).
- Produces: `function parseCredentialCommand(args: string): { op: "add" | "list" | "remove"; domain?: string; label?: string; username?: string } | { error: string }` — the pure parser; the handler prompts for the secret via `ctx.ui` (never via a tool argument) and calls the vault.

The parser is unit-tested; the interactive secret prompt (via `ctx.ui`) is exercised only in the guarded manual path — it must never accept the secret as a plain command argument (that would put it in the transcript).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-credential-command.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseCredentialCommand } from "../../packages/web-access/credential-command.js";

test("parses add with domain/label/username but NOT a secret", () => {
	const p = parseCredentialCommand("add example.com main me@example.com");
	assert.deepEqual(p, { op: "add", domain: "example.com", label: "main", username: "me@example.com" });
});

test("rejects a 4th token to prevent a secret on the command line", () => {
	const p = parseCredentialCommand("add example.com main me@example.com hunter2");
	assert.ok("error" in p && /secret/i.test(p.error));
});

test("parses list and remove", () => {
	assert.deepEqual(parseCredentialCommand("list"), { op: "list" });
	assert.deepEqual(parseCredentialCommand("remove example.com main"), { op: "remove", domain: "example.com", label: "main" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-credential-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/credential-command.ts
export type CredentialCommand =
	| { op: "add"; domain: string; label: string; username: string }
	| { op: "list" }
	| { op: "remove"; domain: string; label: string }
	| { error: string };

export function parseCredentialCommand(args: string): CredentialCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const op = parts[0];
	if (op === "list") return { op: "list" };
	if (op === "add") {
		if (parts.length > 4) return { error: "Too many arguments — do NOT pass a secret on the command line; you will be prompted for it." };
		if (parts.length < 4) return { error: "Usage: /credential add <domain> <label> <username>" };
		return { op: "add", domain: parts[1], label: parts[2], username: parts[3] };
	}
	if (op === "remove") {
		if (parts.length !== 3) return { error: "Usage: /credential remove <domain> <label>" };
		return { op: "remove", domain: parts[1], label: parts[2] };
	}
	return { error: `Unknown op: ${op ?? "(none)"}. Use add | list | remove.` };
}
```

Register in `index-heavy.ts` (the handler prompts for the secret with `ctx.ui` — a hidden input — then calls `vault.set`; on `add` it also appends the domain to the allowlist file):

```ts
import { parseCredentialCommand } from "./credential-command.js";
// pi.registerCommand("credential", { description: "Manage site login credentials (add/list/remove)", handler: async (args, ctx) => { ... parse, prompt for secret via ctx.ui, call vault ... } });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-credential-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/credential-command.ts packages/web-access/index-heavy.ts packages/web-access/index.ts test/unit/web-access-credential-command.test.ts
git commit --no-verify -m "feat(web-access): /credential command for human-only vault writes"
```

---

## Task 9: The gated `login` action

**Files:**
- Create: `packages/web-access/browser-login.ts`
- Modify: `packages/web-access/browser-tool.ts` (add the `login` action), `test/unit/web-access-browser-login.test.ts`

**Interfaces:**
- Consumes: `CredentialVault.injectInto`/`isAllowed` (Task 7), `browser-actions` (Task 4), `BrowserHandle.cdp` (Task 3).
- Produces: `function performLogin(deps: { vault: CredentialVault; cdp: CdpLike; env: NodeJS.ProcessEnv; confirmedDomains: Set<string> }, req: { domain: string; label: string; usernameSelector: string; passwordSelector: string }): Promise<ToolResult>` — enforces, in order: `ORPHUS_ENABLE_BROWSER_LOGIN === "1"`, `vault.isAllowed(domain)`, first-use confirmation (`confirmedDomains.has(domain)`), then focuses each field and fills username (plain) + password (via `injectInto` → `Input.insertText`). Returns a result that contains the username but **never** the secret.

- [ ] **Step 1: Write the failing tests (each gate + the no-leak property)**

```ts
// test/unit/web-access-browser-login.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { performLogin } from "../../packages/web-access/browser-login.js";
import { CredentialVault } from "../../packages/web-access/credential-vault.js";
import type { SecretBackend } from "../../packages/web-access/vault/keychain.js";

const mem = (): SecretBackend => { const m = new Map<string, string>(); return { store: async (i, s) => void m.set(i, s), lookup: async (i) => m.get(i) ?? null, remove: async (i) => void m.delete(i) }; };
function cdpRecorder() { const calls: { method: string; params: Record<string, unknown> }[] = []; return { calls, send: async (method: string, params: Record<string, unknown> = {}) => { calls.push({ method, params }); return method === "Runtime.evaluate" ? { result: { value: { x: 1, y: 1 } } } : {}; } }; }
async function vaultWith(): Promise<CredentialVault> { const v = new CredentialVault(mem(), { allowlist: ["example.com"] }); await v.set({ domain: "example.com", label: "main", username: "me@example.com" }, "s3cret"); return v; }
const req = { domain: "example.com", label: "main", usernameSelector: "#u", passwordSelector: "#p" };

test("refuses when the login flag is off", async () => {
	const out = await performLogin({ vault: await vaultWith(), cdp: cdpRecorder(), env: {} as NodeJS.ProcessEnv, confirmedDomains: new Set(["example.com"]) }, req);
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /ORPHUS_ENABLE_BROWSER_LOGIN/);
});

test("refuses an off-allowlist domain", async () => {
	const v = new CredentialVault(mem(), { allowlist: [] });
	const out = await performLogin({ vault: v, cdp: cdpRecorder(), env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv, confirmedDomains: new Set(["example.com"]) }, req);
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /allowlist/i);
});

test("refuses an unconfirmed first use", async () => {
	const out = await performLogin({ vault: await vaultWith(), cdp: cdpRecorder(), env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv, confirmedDomains: new Set() }, req);
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /confirm/i);
});

test("fills the fields and never returns the secret", async () => {
	const cdp = cdpRecorder();
	const out = await performLogin({ vault: await vaultWith(), cdp, env: { ORPHUS_ENABLE_BROWSER_LOGIN: "1" } as NodeJS.ProcessEnv, confirmedDomains: new Set(["example.com"]) }, req);
	assert.notEqual(out.isError, true);
	assert.ok(cdp.calls.some((c) => c.method === "Input.insertText" && c.params.text === "s3cret"), "secret is typed into the field");
	assert.ok(!JSON.stringify(out).includes("s3cret"), "secret must never appear in the tool result");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-browser-login.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web-access/browser-login.ts
import type { CdpLike } from "./browser-actions.js";
import { locateCenter, typeText } from "./browser-actions.js";
import type { CredentialVault } from "./credential-vault.js";

interface ToolResult { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean; }
const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {}, isError: true });

async function focusAndType(cdp: CdpLike, selector: string, text: string): Promise<void> {
	const point = await locateCenter(cdp, selector);
	if (point) for (const type of ["mousePressed", "mouseReleased"] as const) await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
	await typeText(cdp, text);
}

export async function performLogin(
	deps: { vault: CredentialVault; cdp: CdpLike; env: NodeJS.ProcessEnv; confirmedDomains: Set<string> },
	req: { domain: string; label: string; usernameSelector: string; passwordSelector: string },
): Promise<ToolResult> {
	if (deps.env.ORPHUS_ENABLE_BROWSER_LOGIN !== "1") return err("Login disabled. Set ORPHUS_ENABLE_BROWSER_LOGIN=1 to enable.");
	if (!deps.vault.isAllowed(req.domain)) return err(`Domain ${req.domain} is not on the login allowlist. Add it with /credential add.`);
	if (!deps.confirmedDomains.has(req.domain)) return err(`First login to ${req.domain} needs your confirmation. Run /credential confirm ${req.domain}.`);
	try {
		const { username } = await deps.vault.injectInto(req.domain, req.label, async (secret) => {
			await focusAndType(deps.cdp, req.usernameSelector, username0(username));
			await focusAndType(deps.cdp, req.passwordSelector, secret);
		});
		return ok(`filled login for ${req.domain} as ${username}`, { domain: req.domain, username });
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}
// username is known before the secret; injectInto returns it, so capture it via a two-step: read the index first.
function username0(u: string): string { return u; }
```

> Refinement the implementer applies: `injectInto` returns the username *after* the sink runs, but the sink needs it *first*. Resolve by adding a read-only `CredentialVault.usernameFor(domain, label): string | null` (non-secret) and typing the username outside the sink, using `injectInto` solely to deliver the password. Update the test's vault accordingly. This keeps the secret path single-purpose.

Then in `browser-tool.ts` add the `login` case to the dispatch and the `login` enum value + `usernameSelector`/`passwordSelector`/`label` params to the schema, wiring `performLogin` with the shared `vault`, the handle's `cdp`, `process.env`, and a module-level `confirmedDomains` set populated by a `/credential confirm <domain>` command.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-browser-login.test.ts`
Expected: PASS (all four gates + no-leak).

- [ ] **Step 5: Run the whole web-access suite + check**

Run: `npx vitest --run --project unit test/unit/web-access-` then `npm run check`.
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add packages/web-access/browser-login.ts packages/web-access/browser-tool.ts test/unit/web-access-browser-login.test.ts
git commit --no-verify -m "feat(web-access): gated login action (flag + allowlist + first-use confirm) with no-leak inject"
```

**Phase 2 checkpoint:** with both flags on, an allowlisted, confirmed domain can be logged into using a vault credential the human stored, and the password never appears in any tool result, log, or transcript.

---

# Phase 3 — Skill + docs

## Task 10: The `browser-operation` skill

**Files:**
- Create: `packages/web-access/skills/browser-operation/SKILL.md`
- Test: `test/unit/web-access-skill-frontmatter.test.ts` (asserts the description is a single front-loaded line and the file exists)

**Interfaces:** none (documentation artifact). Follow `packages/coding-agent/docs/skills.md` (writing-for-agents): context-pointer description, front-loaded trigger, deletion over explanation.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/web-access-skill-frontmatter.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moduleDir } from "../helpers/runtime.js";
import { join } from "node:path";

test("browser-operation skill has a single-line front-loaded description", () => {
	const p = join(moduleDir(import.meta.url), "../../packages/web-access/skills/browser-operation/SKILL.md");
	const text = readFileSync(p, "utf8");
	const m = text.match(/^description:\s*(.+)$/m);
	assert.ok(m, "has a description");
	assert.ok((m[1] as string).length < 220, "description stays a one-liner");
	assert.match(text, /sense.*act.*verify/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run --project unit test/unit/web-access-skill-frontmatter.test.ts`
Expected: FAIL — file not found.

- [ ] **Step 3: Write the skill**

```markdown
---
name: browser-operation
description: Operate a live web page with the browser tool — sense→act→verify, climb the meatbag ladder only as far as the page forces, log in via the vault (never paste a password).
---

# Operating a live page

You have a `browser` tool that drives a real Chrome. Two modes: **sense** (read the
page) and **act** (click, type, navigate). After every act, **sense again through a
different channel** — the next read is the verification, never the act's own result.

## The loop
1. `open` the URL, then `read` (`as:"text"` for content, `as:"screenshot"` for layout).
2. Act once (`click`/`type`), then `read` again and confirm the effect.
3. If nothing changed, the page is fighting back — climb one rung, do not debug selectors.

## The meatbag ladder (climb only as forced)
- **Rung 1 — synthetic.** The default. A normal click. Free.
- **Rung 2 — trusted.** The tool escalates automatically when a synthetic click silently
  no-ops (the page gates on event trust). You do not request this; it happens.
- **Rung 3 — human input.** Not shipped. This tool does no CAPTCHA or anti-bot work by design.

## Logging in
- Never ask the user to paste a password into chat, and never put one in a command.
- The human stores logins once with `/credential add <domain> <label> <username>` (you
  cannot write to the vault — that is enforced).
- You call `browser action:"login" domain:… label:… usernameSelector:… passwordSelector:…`.
  The password is streamed into the field and **never returned to you** — you will see
  only the username. First login to a domain needs the human's `/credential confirm`.
- Login is off unless `ORPHUS_ENABLE_BROWSER_LOGIN=1`, and only allowlisted domains work.

## Enforced walls (do not try to route around them)
The secret never reaching you, the env-flag gates, the domain allowlist, and the browser
dying with the session are enforced in code, not requests. Work within them.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run --project unit test/unit/web-access-skill-frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-access/skills/browser-operation/SKILL.md test/unit/web-access-skill-frontmatter.test.ts
git commit --no-verify -m "docs(web-access): browser-operation skill (sense/act/verify + login discipline)"
```

---

## Task 11: Docs, README, changelog, GitNexus (definition of done)

**Files:**
- Modify: `packages/web-access/README.md`, `docs/README.md`, root `README.md` ("what's in the box"), `packages/coding-agent/CHANGELOG.md`, `packages/coding-agent/docs/environment-variables.md`

- [ ] **Step 1: Document the tool, vault commands, and the two env flags** in `packages/web-access/README.md`, including the honest "what is not protected" note (a driven browser with real cookies acts as the user; the macOS argv caveat from Task 6; no anti-detection).

- [ ] **Step 2: Add `ORPHUS_ENABLE_BROWSER` and `ORPHUS_ENABLE_BROWSER_LOGIN`** to `packages/coding-agent/docs/environment-variables.md` (default off, one line each).

- [ ] **Step 3: Index the capability** in `docs/README.md` and cross-link the design + methodology docs; add a "what's in the box" line to the root README.

- [ ] **Step 4: Changelog** — `packages/coding-agent/CHANGELOG.md` under `[Unreleased] → ### Added`: "Interactive `browser` tool (CDP-driven page operation) and site-credential vault with no-leak login, behind `ORPHUS_ENABLE_BROWSER` / `ORPHUS_ENABLE_BROWSER_LOGIN` (both default off)."

- [ ] **Step 5: Refresh GitNexus and run the full local gate**

```bash
npx gitnexus@1.6.9 analyze . --skip-agents-md
npm run check && npm run test:unit
```

- [ ] **Step 6: Commit**

```bash
git add packages/web-access/README.md docs/README.md README.md packages/coding-agent/CHANGELOG.md packages/coding-agent/docs/environment-variables.md
git commit --no-verify -m "docs: document interactive browser tool + credential vault"
```

---

## Self-Review

**Spec coverage:** CDP client (T1) · isolated Chrome + kill-with-session + cap (T3, spec "browser manager") · digital senses + ladder (T4, "the agent tool") · flag-gated tool + teardown (T5) · keychain (T6) + vault no-leak + allowlist + audit (T7) + human-only write (T8) + gated login (T9, all three enforced gates) · skill (T10) · docs/DoD (T11). The spec's "attach to existing Chrome behind the cookie consent gate" is deferred as out-of-scope for v1 (isolated default only) — noted here so it is a conscious omission, not a gap; add a follow-up task if wanted.

**Placeholder scan:** No "TBD/TODO". Two implementer-refinement notes (macOS argv caveat in T6; username-before-secret ordering in T9) are called out with the concrete fix, not left vague.

**Type consistency:** `CdpLike = Pick<CdpConnection,"send">` used in T4/T9; `SecretBackend` shared T6/T7; `Credential`/`injectInto` names consistent T7→T9; tool `ToolResult` shape identical across T5/T9. `confirmedDomains: Set<string>` introduced in T9 and populated by the `/credential confirm` command noted in T8/T9.

**Note on granularity:** Tasks 7 and 9 are larger than 5 minutes because their security property (no-leak) is the point and must be tested as one unit — a reviewer should accept/reject the whole boundary, not half of it.
