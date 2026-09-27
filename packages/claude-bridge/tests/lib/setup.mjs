/**
 * Unit-suite preload: map the host-only Orphus module to a fixture and redirect
 * the bridge's debug log to a throwaway directory.
 *
 * src/index.ts resolves DEBUG_LOG_PATH into a module-level const at import time
 * (and mkdirs it when CLAUDE_BRIDGE_DEBUG=1), so the override has to be in place
 * before any test imports the module. Doing that per test file is easy to forget,
 * and forgetting is invisible: the suite still passes everywhere except on a
 * developer machine with CLAUDE_BRIDGE_DEBUG=1, where the tests instead append
 * fixture data to the real ~/.pi/agent/claude-bridge.log.
 *
 * Wiring this as `node --import ./tests/lib/setup.mjs` guarantees it runs first
 * in every test child process. tests/unit-debug-path.mjs asserts it took effect.
 */
import * as Module from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (Module.registerHooks) {
	const codingAgentShim = new URL("../fixtures/orphus-coding-agent/index.js", import.meta.url).href;
	Module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@orphus/coding-agent") return { url: codingAgentShim, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
} else {
	Module.register(new URL("./orphus-loader.mjs", import.meta.url), import.meta.url);
}
const logDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(logDir, "claude-bridge.log");
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));
