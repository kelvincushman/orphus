import type { ExtensionAPI } from "@orphus/coding-agent";
import { Type } from "typebox";
import { clickWithEscalation, readPage, typeText } from "./browser-actions.js";
import type { BrowserManager } from "./browser-manager.js";

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });
const err = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details, isError: true });

interface BrowserArgs {
	action: string;
	handle?: string;
	url?: string;
	selector?: string;
	text?: string;
	as?: "text" | "dom" | "accessibility" | "screenshot";
}

/** Cap on model-visible read output; readPage's own callers rely on this to keep large DOM/AX dumps out of context. */
const READ_TEXT_CHAR_CAP = 20_000;

export function buildBrowserExecute(manager: BrowserManager, env: NodeJS.ProcessEnv = process.env) {
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
				case "close": {
					await manager.get(name)?.stop();
					return ok(`closed ${name}`);
				}
				default:
					return err(`unknown action: ${args.action}`);
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
		description:
			"Drive a live Chrome to see and operate a real web page: open a URL, read the page (text/dom/accessibility/screenshot), click, type, and close. Sense → act → verify: after acting, read again to confirm. Requires ORPHUS_ENABLE_BROWSER=1.",
		promptSnippet:
			"Use to interact with a live page (click/type/navigate) when fetch_content is not enough. Read after every act to verify.",
		parameters: Type.Object({
			action: Type.String({ enum: ["open", "read", "click", "type", "wait_for", "close"], description: "What to do" }),
			handle: Type.Optional(Type.String({ description: 'Browser instance name (default: "default")' })),
			url: Type.Optional(Type.String({ description: "URL for open" })),
			selector: Type.Optional(Type.String({ description: "CSS selector for click" })),
			text: Type.Optional(Type.String({ description: "Text for type" })),
			as: Type.Optional(Type.String({ enum: ["text", "dom", "accessibility", "screenshot"], description: "Read channel (default: text)" })),
		}),
		execute: async (_toolCallId, params) => execute(params as BrowserArgs),
	});
	pi.on("session_shutdown", async () => {
		await manager.stopAll();
	});
}
