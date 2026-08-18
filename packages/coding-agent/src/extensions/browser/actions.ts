import type { CredentialGrant } from "./credential-gate.ts";
import type { CdpSession } from "./page-session.ts";

/**
 * Which actions may be retried, and which may not.
 *
 * An *observation* asks the page a question. Repeating it changes nothing, so a
 * transient failure is worth another attempt. An *action* changes the page — a
 * click submits, a navigation posts, a keystroke lands. When one of those fails
 * in a way that leaves its completion uncertain, retrying may do it twice. The
 * harness reports the uncertainty instead of guessing.
 */
export const OBSERVATION_ACTIONS = ["snapshot", "screenshot", "status"] as const;
export const MUTATING_ACTIONS = ["open", "navigate", "click", "type", "login", "close"] as const;

export type ObservationAction = (typeof OBSERVATION_ACTIONS)[number];
export type MutatingAction = (typeof MUTATING_ACTIONS)[number];
export type BrowserAction = ObservationAction | MutatingAction;

export function isObservation(action: string): action is ObservationAction {
	return (OBSERVATION_ACTIONS as readonly string[]).includes(action);
}

export interface RetryOptions {
	attempts?: number;
	sleep?: (ms: number) => Promise<void>;
	delayMs?: number;
}

/** Retry an observation a bounded number of times. Never used for a mutating action. */
export async function retryObservation<T>(run: () => Promise<T>, options?: RetryOptions): Promise<T> {
	const attempts = Math.max(1, options?.attempts ?? 3);
	const delayMs = options?.delayMs ?? 250;
	const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await run();
		} catch (error) {
			lastError = error;
			if (attempt < attempts - 1) await sleep(delayMs);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Raised when a page-changing command failed without telling us whether it took
 * effect. The message says so plainly rather than implying nothing happened.
 */
export class UncertainActionError extends Error {
	readonly action: string;
	constructor(action: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`The \`${action}\` action failed and its effect on the page is unknown: ${detail}. ` +
				`It was not retried, because repeating it could apply it twice. ` +
				`Use \`snapshot\` to see the page's current state before deciding what to do.`,
		);
		this.name = "UncertainActionError";
		this.action = action;
		this.cause = cause;
	}
}

/** Run a page-changing command, converting a failure into an explicit uncertainty. */
export async function runMutating<T>(action: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw new UncertainActionError(action, error);
	}
}

async function evaluate(client: CdpSession, expression: string): Promise<unknown> {
	const result = (await client.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	})) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Page evaluation threw");
	return result.result?.value;
}

/** Escape a string for embedding in a JavaScript source literal. */
export function jsString(value: string): string {
	return JSON.stringify(value);
}

export interface PageStatus {
	url: string;
	title: string;
}

export async function readStatus(client: CdpSession): Promise<PageStatus> {
	const value = (await evaluate(client, "({ url: location.href, title: document.title })")) as PageStatus | undefined;
	return { url: value?.url ?? "", title: value?.title ?? "" };
}

export interface SnapshotOptions {
	/** Character cap on the returned text. */
	maxChars?: number;
}

export const DEFAULT_SNAPSHOT_CHARS = 20_000;

export interface PageSnapshot extends PageStatus {
	text: string;
	truncated: boolean;
}

/**
 * A text view of the page plus its interactive elements.
 *
 * Deliberately not a DOM dump: the model needs to know what it can read and
 * what it can click, and a full serialization of a modern page is mostly
 * framework noise that would swamp the context window.
 */
export async function snapshot(client: CdpSession, options?: SnapshotOptions): Promise<PageSnapshot> {
	const maxChars = options?.maxChars ?? DEFAULT_SNAPSHOT_CHARS;
	const value = (await evaluate(
		client,
		`(() => {
			const interactive = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"]')]
				.slice(0, 200)
				.map((el, index) => {
					const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.textContent || '').trim().slice(0, 80);
					const selector = el.id ? '#' + CSS.escape(el.id) : el.getAttribute('name') ? el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.getAttribute('name')) + ']' : '';
					return (index + 1) + '. <' + el.tagName.toLowerCase() + '> ' + label + (selector ? '  selector: ' + selector : '');
				});
			return {
				url: location.href,
				title: document.title,
				text: (document.body ? document.body.innerText : '') + (interactive.length ? '\\n\\n--- interactive elements ---\\n' + interactive.join('\\n') : ''),
			};
		})()`,
	)) as (PageStatus & { text?: string }) | undefined;
	const text = value?.text ?? "";
	return {
		url: value?.url ?? "",
		title: value?.title ?? "",
		text: text.length > maxChars ? text.slice(0, maxChars) : text,
		truncated: text.length > maxChars,
	};
}

export async function navigate(client: CdpSession, url: string): Promise<PageStatus> {
	await client.send("Page.enable");
	// The swallow handler is attached at creation, not at the later await: if
	// Page.navigate throws first, an unhandled once-timeout 30s later would
	// otherwise take the whole process down. A page that never fires `load` (a
	// long poll, a stream) is still navigated; the status read below reports
	// where we actually ended up.
	const loaded = client.once("Page.loadEventFired", 30_000).catch(() => undefined);
	const result = (await client.send("Page.navigate", { url })) as { errorText?: string };
	if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
	await loaded;
	return readStatus(client);
}

export async function click(client: CdpSession, selector: string): Promise<void> {
	const clicked = await evaluate(
		client,
		`(() => { const el = document.querySelector(${jsString(selector)}); if (!el) return false; el.click(); return true; })()`,
	);
	if (clicked !== true) throw new Error(`No element matched ${selector}`);
}

export async function typeInto(client: CdpSession, selector: string, text: string): Promise<void> {
	const typed = await evaluate(
		client,
		`(() => {
			const el = document.querySelector(${jsString(selector)});
			if (!el) return false;
			el.focus();
			el.value = ${jsString(text)};
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		})()`,
	);
	if (typed !== true) throw new Error(`No element matched ${selector}`);
}

export async function screenshot(client: CdpSession): Promise<string> {
	const result = (await client.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
	if (!result.data) throw new Error("The browser returned no screenshot data");
	return result.data;
}

export interface LoginFields {
	usernameSelector?: string;
	passwordSelector: string;
	submitSelector?: string;
}

/**
 * Fill a login form from a granted credential.
 *
 * The secret is written straight into the page through a CDP evaluation and is
 * never returned, rendered, or logged. The caller gets the label back, which is
 * the only part of a credential allowed into model-visible context.
 */
export async function submitLogin(client: CdpSession, grant: CredentialGrant, fields: LoginFields): Promise<string> {
	if (grant.username && fields.usernameSelector) {
		await typeInto(client, fields.usernameSelector, grant.username);
	}
	await typeInto(client, fields.passwordSelector, grant.secret);
	if (fields.submitSelector) await click(client, fields.submitSelector);
	return grant.label;
}
