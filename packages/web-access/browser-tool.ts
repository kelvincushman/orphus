import type { ExtensionAPI } from "@orphus/coding-agent";
import { Type } from "typebox";
import { clickWithEscalation, readPage, typeText } from "./browser-actions.js";
import { performLogin } from "./browser-login.js";
import type { BrowserManager } from "./browser-manager.js";
import type { CredentialVault } from "./credential-vault.js";

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });
// pi's agent loop hardcodes isError:false for any resolved execute() result, so isError here is
// not what surfaces the failure to the model — `details.error` is. index.ts's "tool_result" hook
// reads it (mirroring isAllFailedWebResult) to flag the result as an error after the fact. Both
// are set: `isError` for direct callers of buildBrowserExecute (see the unit test), `details.error`
// for the pi runtime.
const err = (text: string, details: Record<string, unknown> = {}): ToolResult => ({
	content: [{ type: "text", text }],
	details: { ...details, error: true },
	isError: true,
});

interface BrowserArgs {
	action: string;
	handle?: string;
	url?: string;
	selector?: string;
	text?: string;
	as?: "text" | "dom" | "accessibility" | "screenshot";
	domain?: string;
	label?: string;
	usernameSelector?: string;
	passwordSelector?: string;
}

/** Cap on model-visible read output; readPage's own callers rely on this to keep large DOM/AX dumps out of context. */
const READ_TEXT_CHAR_CAP = 20_000;

/** Bounded poll for wait_for: give a page a fair chance to settle without hanging the tool call forever. */
const WAIT_FOR_TIMEOUT_MS = 10_000;
const WAIT_FOR_INTERVAL_MS = 200;

export function buildBrowserExecute(
	manager: BrowserManager,
	env: NodeJS.ProcessEnv = process.env,
	vault?: CredentialVault,
	confirmedDomains: Set<string> = new Set(),
) {
	return async (args: BrowserArgs): Promise<ToolResult> => {
		if (env.ORPHUS_ENABLE_BROWSER !== "1") {
			return err("Browser tool disabled. Set ORPHUS_ENABLE_BROWSER=1 to enable.");
		}
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
					return ok(out.slice(0, READ_TEXT_CHAR_CAP), { handle: name, as: args.as ?? "text" });
				}
				case "click": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					if (!args.selector) return err("click requires a selector");
					const before = await readPage(h.cdp, "text");
					const rung = await clickWithEscalation(
						h.cdp,
						args.selector,
						async () => (await readPage(h.cdp, "text")) !== before,
					);
					return rung === "failed"
						? err(`click did not land on ${args.selector}`)
						: ok(`clicked ${args.selector} (${rung})`, { rung });
				}
				case "type": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					await typeText(h.cdp, args.text ?? "");
					return ok(`typed ${args.text?.length ?? 0} chars`, { handle: name });
				}
				case "wait_for": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					const expr = args.selector
						? `!!document.querySelector(${JSON.stringify(args.selector)})`
						: `document.readyState === "complete"`;
					const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
					for (;;) {
						const res = (await h.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })) as {
							result?: { value?: boolean };
						};
						if (res.result?.value) {
							return ok(args.selector ? `${args.selector} appeared` : "page ready", { handle: name });
						}
						if (Date.now() >= deadline) {
							return err(`wait_for timed out after ${WAIT_FOR_TIMEOUT_MS}ms`);
						}
						await Bun.sleep(WAIT_FOR_INTERVAL_MS);
					}
				}
				case "close": {
					await manager.get(name)?.stop();
					return ok(`closed ${name}`);
				}
				case "login": {
					const h = manager.get(name);
					if (!h) return err(`no open browser named ${name}`);
					if (!vault) return err("Credential vault unavailable.");
					if (!args.domain || !args.label || !args.usernameSelector || !args.passwordSelector) {
						return err("login requires domain, label, usernameSelector, and passwordSelector");
					}
					return performLogin(
						{ vault, cdp: h.cdp, env, confirmedDomains },
						{ domain: args.domain, label: args.label, usernameSelector: args.usernameSelector, passwordSelector: args.passwordSelector },
					);
				}
				default:
					return err(`unknown action: ${args.action}`);
			}
		} catch (e) {
			return err(e instanceof Error ? e.message : String(e));
		}
	};
}

export function registerBrowserTool(
	pi: ExtensionAPI,
	manager: BrowserManager,
	vault?: CredentialVault,
	confirmedDomains: Set<string> = new Set(),
): void {
	const execute = buildBrowserExecute(manager, process.env, vault, confirmedDomains);
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description:
			"Drive a live Chrome to see and operate a real web page: open a URL, read the page (text/dom/accessibility/screenshot), click, type, close, and (behind ORPHUS_ENABLE_BROWSER_LOGIN=1) log into an allowlisted, human-confirmed site using a vault credential without the password ever reaching the model. Sense → act → verify: after acting, read again to confirm. Requires ORPHUS_ENABLE_BROWSER=1.",
		promptSnippet:
			"Use to interact with a live page (click/type/navigate) when fetch_content is not enough. Read after every act to verify.",
		parameters: Type.Object({
			action: Type.String({ enum: ["open", "read", "click", "type", "wait_for", "close", "login"], description: "What to do" }),
			handle: Type.Optional(Type.String({ description: 'Browser instance name (default: "default")' })),
			url: Type.Optional(Type.String({ description: "URL for open" })),
			selector: Type.Optional(Type.String({ description: "CSS selector for click" })),
			text: Type.Optional(Type.String({ description: "Text for type" })),
			as: Type.Optional(Type.String({ enum: ["text", "dom", "accessibility", "screenshot"], description: "Read channel (default: text)" })),
			domain: Type.Optional(Type.String({ description: "Domain for login (must be vault-allowlisted and human-confirmed)" })),
			label: Type.Optional(Type.String({ description: "Vault credential label for login" })),
			usernameSelector: Type.Optional(Type.String({ description: "CSS selector for the username field (login)" })),
			passwordSelector: Type.Optional(Type.String({ description: "CSS selector for the password field (login)" })),
		}),
		execute: async (_toolCallId, params) => execute(params as BrowserArgs),
	});
	pi.on("session_shutdown", async () => {
		await manager.stopAll();
	});
}
