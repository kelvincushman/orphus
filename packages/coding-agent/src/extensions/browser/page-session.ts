import type { CdpClient } from "./cdp-client.ts";

/**
 * The command surface the page actions need.
 *
 * A DevTools endpoint's default connection talks to the *browser*, where
 * `Page.*` and `Runtime.*` do not exist. Everything that operates on a page has
 * to be addressed to an attached target session, so the actions take this
 * narrower interface and never see the browser-level client.
 */
export interface CdpSession {
	send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	once(method: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** A page target, with its session id folded into every command. */
export class AttachedPage implements CdpSession {
	readonly targetId: string;
	readonly sessionId: string;
	private readonly client: CdpClient;

	constructor(client: CdpClient, targetId: string, sessionId: string) {
		this.client = client;
		this.targetId = targetId;
		this.sessionId = sessionId;
	}

	send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.client.send(method, params, this.sessionId);
	}

	once(method: string, timeoutMs?: number): Promise<Record<string, unknown>> {
		return this.client.once(method, timeoutMs);
	}
}

/**
 * Open a page in the browser and attach to it.
 *
 * `flatten: true` puts the page's commands and events on the same connection
 * rather than the deprecated nested `Target.sendMessageToTarget` envelope, so
 * one socket carries the whole session.
 */
export async function attachNewPage(client: CdpClient, url = "about:blank"): Promise<AttachedPage> {
	const created = (await client.send("Target.createTarget", { url })) as { targetId?: string };
	if (!created.targetId) throw new Error("The browser did not return a page target");
	const attached = (await client.send("Target.attachToTarget", {
		targetId: created.targetId,
		flatten: true,
	})) as { sessionId?: string };
	if (!attached.sessionId) throw new Error("The browser did not return a target session");
	return new AttachedPage(client, created.targetId, attached.sessionId);
}
