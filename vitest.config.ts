import { defineConfig } from "vitest/config";
import { sharedAliases } from "./vitest.base.js";
import { TEST_TIMEOUT_MS } from "./test/helpers/test-timeout.js";

export { TEST_TIMEOUT_MS };
export { QUARANTINED_TESTS };

/**
 * `bunfig.toml`'s `[test] preload` moved here verbatim. The file registers one
 * `beforeEach` installing a fresh in-memory durable backend, and needs no edit:
 * its `beforeEach` import resolves through the `bun:test` alias.
 */
const setupFiles = ["./test/setup-workflow-durability.ts"];

/**
 * Tests quarantined from collection, with the reason each one is here.
 *
 * A test goes on this list rather than being skipped inside its file, because
 * a soft guard inside a test keeps the name in the pass count while its
 * assertions do nothing; this list is countable and shows up in review.
 *
 * Deleting an entry is the goal. Adding one needs the same standard of proof:
 * demonstrated failing on a pristine checkout, with the cause understood.
 * The last entry (interactive-engine-cycle-fallback, issue #66) turned out to
 * be provider API keys leaking from the runner's env into the fixture's model
 * world — fixed in the test's Driver, not the engine.
 */
const QUARANTINED_TESTS: readonly string[] = [];

const project = (name: string, directory: string) => ({
	resolve: { alias: sharedAliases },
	test: {
		name,
		root: import.meta.dirname,
		environment: "node" as const,
		globals: true,
		include: [`${directory}/**/*.test.ts`],
		exclude: ["**/node_modules/**", ...QUARANTINED_TESTS],
		setupFiles,
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
	},
});

/**
 * Three projects, one per suite directory, so the CI job split, the per-suite
 * flake retry and the diagnostics artifact names all survive the move off
 * `bun test <dir>` unchanged.
 *
 * No `pool`, `maxWorkers`, `poolOptions` or `fileParallelism`: pi sets none, and
 * a suite that only passes serialized is concealing a test that assumes an idle
 * machine rather than fixing it.
 */
export default defineConfig({
	test: {
		projects: [project("unit", "test/unit"), project("integration", "test/integration"), project("ci", "test/ci")],
	},
});
