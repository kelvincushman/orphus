import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { createDefaultCapabilities } from "../../core/capabilities/index.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { readBrowserFlags } from "./env.ts";
import { CREDENTIAL_REGISTRY_FILE, createKeychainCredentials } from "./keychain-credentials.ts";
import { formatCleanupReport } from "./resource-registry.ts";
import { BrowserSession } from "./session.ts";
import { createBrowserTool } from "./tool.ts";

export { BROWSER_TOOL_NAME } from "./tool.ts";

/**
 * Browser operation, available by default and disabled with
 * `ORPHUS_ENABLE_BROWSER=0`.
 *
 * The switch is read once at registration. Disabling it means the `browser`
 * tool never enters the prompt, schema list, or context window. Registration
 * itself starts no browser; the first `open` action launches the isolated Chrome.
 */
export default function browserExtension(pi: ExtensionAPI): void {
	const flags = readBrowserFlags();
	if (!flags.enabled) return;

	const resolved = createDefaultCapabilities();
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
