import type { CdpLike } from "./browser-actions.js";
import { locateCenter, typeText } from "./browser-actions.js";
import type { CredentialVault } from "./credential-vault.js";

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });
// Mirrors browser-tool.ts's err(): details.error is what the "tool_result" hook in index.ts
// reads to surface the failure to pi's agent loop (which hardcodes isError:false for any
// resolved execute() result); isError is set too for direct callers of performLogin.
const err = (text: string, details: Record<string, unknown> = {}): ToolResult => ({
	content: [{ type: "text", text }],
	details: { ...details, error: true },
	isError: true,
});

async function focusAndType(cdp: CdpLike, selector: string, text: string): Promise<void> {
	const point = await locateCenter(cdp, selector);
	if (point) {
		for (const type of ["mousePressed", "mouseReleased"] as const) {
			await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
		}
	}
	await typeText(cdp, text);
}

export interface LoginDeps {
	vault: CredentialVault;
	cdp: CdpLike;
	env: NodeJS.ProcessEnv;
	confirmedDomains: Set<string>;
}

export interface LoginRequest {
	domain: string;
	label: string;
	usernameSelector: string;
	passwordSelector: string;
}

/**
 * Fills a login form using a vault-stored credential without the secret ever
 * reaching the model. Four gates, enforced in order, each a distinct typed
 * refusal: the login feature flag, the vault's domain allowlist, a first-use
 * human confirmation (`confirmedDomains`, populated only by `/credential
 * confirm <domain>`), and — critically — that the live page's origin actually
 * matches the credential's domain. Without the fourth gate, `req.domain` is
 * only ever used as a lookup key: nothing stops a caller from opening
 * `attacker.example` and asking to log in "to" a confirmed, allowlisted
 * domain while the actual page the secret gets typed into is the attacker's.
 * A second check just before typing verifies `passwordSelector` resolves to
 * an actual `<input type="password">`, so the model cannot redirect the
 * secret into an arbitrary field it can read back with `read`.
 *
 * The username is read via `vault.usernameFor` (non-secret) and typed into
 * `usernameSelector` *before* any secret work, since `injectInto` only
 * returns the username *after* its sink has already run. The password is
 * typed exclusively inside the `injectInto` sink, so the secret's only path
 * out of the vault is straight into `Input.insertText` on the page — it is
 * never assigned to a variable this function can place in a return value or
 * a log line.
 */
export async function performLogin(deps: LoginDeps, req: LoginRequest): Promise<ToolResult> {
	if (deps.env.ORPHUS_ENABLE_BROWSER_LOGIN !== "1") {
		return err("Browser login disabled. Set ORPHUS_ENABLE_BROWSER_LOGIN=1 to enable.");
	}
	if (!deps.vault.isAllowed(req.domain)) {
		return err(`Domain ${req.domain} is not on the credential vault allowlist. Add it with /credential add.`);
	}
	if (!deps.confirmedDomains.has(req.domain)) {
		return err(`First login to ${req.domain} needs your confirmation. Run /credential confirm ${req.domain}.`);
	}

	try {
		// Origin binding: req.domain is otherwise only a lookup key. Refuse unless the live
		// page's hostname is the credential's domain or a subdomain of it, so a page navigated
		// to a different origin can never receive this domain's secret.
		const host = (await deps.cdp.send("Runtime.evaluate", { expression: "location.hostname", returnByValue: true })) as {
			result?: { value?: string };
		};
		const hostname = host.result?.value ?? "";
		if (hostname !== req.domain && !hostname.endsWith(`.${req.domain}`)) {
			return err(
				`refusing to enter the ${req.domain} credential on ${hostname} — the page origin does not match the credential's domain`,
			);
		}

		const username = deps.vault.usernameFor(req.domain, req.label);
		if (username === null) {
			return err(`No stored credential for ${req.domain}/${req.label}. Add one with /credential add.`);
		}

		// Field-type binding: the model supplies passwordSelector, so confirm it actually
		// resolves to a password input before the secret sink runs — otherwise a selector
		// pointed at a plain text field would let the model read the secret back via `read`.
		const isPasswordField = (await deps.cdp.send("Runtime.evaluate", {
			expression: `(()=>{const el=document.querySelector(${JSON.stringify(req.passwordSelector)});return !!el && el.tagName==='INPUT' && el.type==='password';})()`,
			returnByValue: true,
		})) as { result?: { value?: boolean } };
		if (isPasswordField.result?.value !== true) {
			return err(`refusing to fill ${req.passwordSelector} — it is not a password input`);
		}

		await focusAndType(deps.cdp, req.usernameSelector, username);
		await deps.vault.injectInto(req.domain, req.label, async (secret) => {
			await focusAndType(deps.cdp, req.passwordSelector, secret);
		});
		return ok(`filled login for ${req.domain} as ${username}`, { domain: req.domain, username });
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}
