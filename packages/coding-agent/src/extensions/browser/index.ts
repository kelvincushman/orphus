import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { createDefaultCapabilities, type HarnessCapabilities } from "../../core/capabilities/index.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { readBrowserFlags } from "./env.ts";
import { CREDENTIAL_REGISTRY_FILE, createKeychainCredentials } from "./keychain-credentials.ts";
import { formatCleanupReport } from "./resource-registry.ts";
import { BrowserSession } from "./session.ts";
import { createBrowserTool } from "./tool.ts";

export { BROWSER_TOOL_NAME } from "./tool.ts";

/**
 * Browser operation, behind `ORPHUS_ENABLE_BROWSER`.
 *
 * The switch is read once at registration: with the flag off the `browser` tool
 * is never registered, so a session that did not opt in does not carry the tool
 * in its prompt, its schema list, or its context window.
 */
export default function browserExtension(pi: ExtensionAPI, capabilities?: HarnessCapabilities): void {
	const flags = readBrowserFlags();
	if (!flags.enabled) return;

	const resolved = capabilities ?? createDefaultCapabilities();
	const session = new BrowserSession({
		processes: resolved.process,
		executablePath: flags.executablePath,
		headless: flags.headless,
		noSandbox: flags.noSandbox,
	});
	// The default bundle's credential vault is empty by design. Browser login
	// reads the OS keychain instead, with its non-secret registry beside the
	// agent config — see keychain-credentials.ts for why the two are split.
	const credentials = flags.loginEnabled
		? createKeychainCredentials({
				processes: resolved.process,
				fs: resolved.fs,
				registryPath: join(getAgentDir(), CREDENTIAL_REGISTRY_FILE),
			})
		: resolved.credentials;

	pi.registerTool(createBrowserTool({ session, credentials, flags }));

	// Shutdown and cancellation both land here. Every registered cleanup is
	// attempted and awaited; anything that failed is said out loud rather than
	// dressed up as a guarantee that nothing was left behind.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!session.isRunning && session.openResourceCount === 0) return;
		const report = await session.close();
		const failures = formatCleanupReport(report);
		if (failures) ctx.ui?.notify(failures, "warning");
	});
}
