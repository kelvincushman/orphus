import type { ExtensionAPI } from "@orphus/coding-agent";
import type { CredentialVault } from "./credential-vault.js";
import { addToAllowlist, persistIndex } from "./vault/vault-store.js";

export type ParsedCredentialCommand =
	| { op: "add"; domain: string; label: string; username: string }
	| { op: "list" }
	| { op: "remove"; domain: string; label: string }
	| { op: "confirm"; domain: string }
	| { error: string };

const USAGE =
	"Usage: /credential add <domain> <label> <username> | /credential list | /credential remove <domain> <label> | /credential confirm <domain>";

/**
 * Pure parser for the `/credential` command. Never touches the vault or the
 * filesystem, and never accepts the secret as a token: `add` takes exactly
 * `<domain> <label> <username>` — a 4th token (a would-be secret typed on the
 * same line) is rejected as a parse error rather than silently accepted, so a
 * secret can never travel through this command as an argument.
 */
export function parseCredentialCommand(args: string): ParsedCredentialCommand {
	const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
	const [sub, ...rest] = tokens;

	if (sub === undefined || sub === "list") {
		if (rest.length > 0) return { error: `/credential list takes no arguments. ${USAGE}` };
		return { op: "list" };
	}

	if (sub === "add") {
		if (rest.length !== 3) {
			return {
				error:
					rest.length > 3
						? `/credential add takes exactly 3 arguments — the secret is never a command argument; enter it via the prompt or ORPHUS_VAULT_SECRET instead. ${USAGE}`
						: `/credential add requires <domain> <label> <username>. ${USAGE}`,
			};
		}
		const [domain, label, username] = rest as [string, string, string];
		return { op: "add", domain, label, username };
	}

	if (sub === "remove") {
		if (rest.length !== 2) {
			return { error: `/credential remove requires <domain> <label>. ${USAGE}` };
		}
		const [domain, label] = rest as [string, string];
		return { op: "remove", domain, label };
	}

	if (sub === "confirm") {
		if (rest.length !== 1) {
			return { error: `/credential confirm requires <domain>. ${USAGE}` };
		}
		const [domain] = rest as [string];
		return { op: "confirm", domain };
	}

	return { error: `Unknown /credential subcommand "${sub}". ${USAGE}` };
}

/**
 * Registers `/credential`, the human-only entry point for writing to the
 * credential vault. The agent has no tool that reaches this command — storing
 * a credential is something only a person typing at the prompt can do.
 *
 * The secret itself is obtained without ever becoming a command argument or a
 * logged/echoed value: `ctx.ui` (see `ExtensionUIContext`) exposes only
 * `input`/`editor`/`hostInputForm`, none of which support a hidden/masked
 * field, so there is no non-echoing UI prompt available. This falls back to
 * `process.env.ORPHUS_VAULT_SECRET`, which the human exports in their shell
 * just before running `/credential add` and unsets immediately after.
 */
export function registerCredentialCommand(pi: ExtensionAPI, vault: CredentialVault, confirmedDomains: Set<string>): void {
	pi.registerCommand("credential", {
		description: "Manage stored web login credentials (add/list/remove/confirm)",
		handler: async (args, ctx) => {
			const parsed = parseCredentialCommand(args);

			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			if (parsed.op === "confirm") {
				confirmedDomains.add(parsed.domain);
				ctx.ui.notify(`Confirmed ${parsed.domain} for browser login. The login action may now use a vault credential on this domain.`, "info");
				return;
			}

			if (parsed.op === "list") {
				const creds = await vault.list();
				if (creds.length === 0) {
					ctx.ui.notify("No stored credentials.", "info");
					return;
				}
				const lines = creds.map((c) => `${c.domain} / ${c.label} (${c.username})`);
				ctx.ui.notify(`Stored credentials:\n${lines.join("\n")}`, "info");
				return;
			}

			if (parsed.op === "remove") {
				await vault.remove(parsed.domain, parsed.label);
				persistIndex(await vault.list());
				ctx.ui.notify(`Removed credential ${parsed.domain} / ${parsed.label}.`, "info");
				return;
			}

			// parsed.op === "add"
			const secret = process.env.ORPHUS_VAULT_SECRET;
			if (!secret) {
				ctx.ui.notify(
					"No secret available. Export ORPHUS_VAULT_SECRET with the credential's password in your shell, " +
						"run /credential add again, then unset ORPHUS_VAULT_SECRET. The value is never echoed, logged, or stored outside the OS keychain.",
					"error",
				);
				return;
			}
			await vault.set({ domain: parsed.domain, label: parsed.label, username: parsed.username }, secret);
			persistIndex(await vault.list());
			addToAllowlist(parsed.domain);
			ctx.ui.notify(`Stored credential for ${parsed.domain} / ${parsed.label} (${parsed.username}).`, "info");
		},
	});
}
