import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CredentialCapability } from "../../core/capabilities/index.ts";
import type { ExtensionContext } from "../../core/extensions/context-types.ts";
import { defineTool, type ToolDefinition } from "../../core/extensions/tool-types.ts";
import {
	click,
	DEFAULT_SNAPSHOT_CHARS,
	isObservation,
	MUTATING_ACTIONS,
	navigate,
	OBSERVATION_ACTIONS,
	readStatus,
	retryObservation,
	runMutating,
	screenshot,
	snapshot,
	submitLogin,
	typeInto,
} from "./actions.ts";
import { CredentialGate, describeDenial, parseOriginAllowlist } from "./credential-gate.ts";
import type { BrowserFlags } from "./env.ts";
import { formatCleanupReport } from "./resource-registry.ts";
import type { BrowserSession } from "./session.ts";

export const BROWSER_TOOL_NAME = "browser";

const ACTIONS = [...OBSERVATION_ACTIONS, ...MUTATING_ACTIONS] as const;

const parameters = Type.Object({
	action: Type.Union(
		ACTIONS.map((action) => Type.Literal(action)),
		{ description: "What to do. All actions share one browser session." },
	),
	url: Type.Optional(Type.String({ description: "Target URL for `navigate`." })),
	selector: Type.Optional(Type.String({ description: "CSS selector for `click`, `type`, and login fields." })),
	text: Type.Optional(Type.String({ description: "Text to enter for `type`." })),
	credentialLabel: Type.Optional(
		Type.String({ description: "Label of a stored credential for `login`. The secret is never shown." }),
	),
	usernameSelector: Type.Optional(Type.String({ description: "CSS selector for the username field on `login`." })),
	submitSelector: Type.Optional(Type.String({ description: "CSS selector for the submit button on `login`." })),
	maxChars: Type.Optional(Type.Number({ description: `Cap on snapshot text. Default ${DEFAULT_SNAPSHOT_CHARS}.` })),
});

export interface BrowserToolOptions {
	session: BrowserSession;
	credentials: CredentialCapability;
	flags: BrowserFlags;
}

function text(content: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details: undefined };
}

/**
 * The single action-dispatched `browser` tool.
 *
 * One tool rather than a dozen, because the actions are not independent: they
 * operate on one browser, in sequence, and a model choosing between `click` and
 * `browser_click` learns nothing useful from the distinction. `executionMode`
 * is sequential for the same reason — two concurrent clicks on one page is not
 * a thing anyone means.
 */
export function createBrowserTool(options: BrowserToolOptions): ToolDefinition {
	const allowlist = parseOriginAllowlist(options.flags.loginOrigins);

	return defineTool({
		name: BROWSER_TOOL_NAME,
		label: "Browser",
		description: [
			"Operate an isolated browser. Every action shares one session, so navigate, read, and click in sequence.",
			"",
			"Actions:",
			"- `open`: start the browser (idempotent).",
			"- `navigate`: go to `url`.",
			"- `snapshot`: read the page as text plus its interactive elements and their selectors.",
			"- `status`: current URL and title.",
			"- `screenshot`: a PNG of the viewport.",
			"- `click`: click the element matching `selector`.",
			"- `type`: enter `text` into the element matching `selector`.",
			"- `login`: fill a login form from a stored credential named by `credentialLabel`. The secret is never disclosed.",
			"- `close`: shut the browser down.",
			"",
			"This browser is its own throwaway profile. It is not your logged-in browser and has none of your sessions.",
		].join("\n"),
		promptSnippet: "browser: operate an isolated browser (navigate, snapshot, click, type)",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const action = params.action;

			if (action === "close") {
				const report = await options.session.close();
				const failures = formatCleanupReport(report);
				return text(
					failures
						? `Browser closed. ${failures}`
						: `Browser closed. ${report.attempted} resource(s) released, none failed.`,
				);
			}

			if (action === "open") {
				await runMutating("open", () => options.session.start(signal));
				return text("Browser open. It runs an isolated, throwaway profile.");
			}

			const client = options.session.require();

			if (isObservation(action)) {
				// Only these get another attempt: asking the page a question twice
				// changes nothing.
				return retryObservation(async () => {
					if (action === "status") {
						const status = await readStatus(client);
						return text(`${status.title || "(untitled)"}\n${status.url}`);
					}
					if (action === "screenshot") {
						const data = await screenshot(client);
						return {
							content: [{ type: "image", data, mimeType: "image/png" }],
							details: undefined,
						} as AgentToolResult<unknown>;
					}
					const page = await snapshot(client, { maxChars: params.maxChars });
					const suffix = page.truncated ? "\n\n[snapshot truncated]" : "";
					return text(`${page.title || "(untitled)"}\n${page.url}\n\n${page.text}${suffix}`);
				});
			}

			if (action === "navigate") {
				if (!params.url) return text("`navigate` needs a `url`.");
				const status = await runMutating("navigate", () => navigate(client, params.url as string));
				return text(`Now at ${status.url}\n${status.title || "(untitled)"}`);
			}

			if (action === "click") {
				if (!params.selector) return text("`click` needs a `selector`.");
				await runMutating("click", () => click(client, params.selector as string));
				return text(`Clicked ${params.selector}.`);
			}

			if (action === "type") {
				if (!params.selector) return text("`type` needs a `selector`.");
				if (params.text === undefined) return text("`type` needs `text`.");
				await runMutating("type", () => typeInto(client, params.selector as string, params.text as string));
				return text(`Entered text into ${params.selector}.`);
			}

			// login
			if (!params.credentialLabel) return text("`login` needs a `credentialLabel`.");
			if (!params.selector) return text("`login` needs a `selector` for the password field.");
			const gate = new CredentialGate({
				credentials: options.credentials,
				loginEnabled: options.flags.loginEnabled,
				allowlist,
				approve: createApprover(ctx),
			});
			const status = await readStatus(client);
			const decision = await gate.resolve(params.credentialLabel, status.url);
			// A denial is a tool error, not a result the model can mistake for success.
			if (!decision.ok) throw new Error(describeDenial(decision.denial, params.credentialLabel));
			const label = await runMutating("login", () =>
				submitLogin(client, decision.grant, {
					usernameSelector: params.usernameSelector,
					passwordSelector: params.selector as string,
					submitSelector: params.submitSelector,
				}),
			);
			// Only the label. The secret reached the page and nothing else.
			return text(`Submitted the login form using credential "${label}".`);
		},
	}) as ToolDefinition;
}

/**
 * The approval prompt, or nothing.
 *
 * A session with no UI to ask — print mode, a subagent, a scheduled run — gets
 * no approver, and {@link CredentialGate} denies. Fail closed: an unattended
 * run must not be able to authorize its own credential use.
 */
function createApprover(
	ctx: ExtensionContext | undefined,
): ((request: { label: string; origin: string; username?: string }) => Promise<boolean>) | undefined {
	const confirm = ctx?.ui?.confirm;
	if (!confirm || !ctx?.ui) return undefined;
	return (request) =>
		ctx.ui.confirm(
			"Use a stored credential in the browser?",
			`Credential "${request.label}"${request.username ? ` (${request.username})` : ""} will be entered into a login form at ${request.origin}. The secret is never shown to the model.`,
		);
}
