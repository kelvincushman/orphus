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
 * This test was already failing on `main` when the CI job that runs this suite
 * was first added — nothing had run it since the fork, so nobody saw it go red.
 * It is listed here rather than skipped inside the file, because a
 * soft guard inside a test keeps the name in the pass count while its assertions
 * do nothing; this list is countable and shows up in review.
 *
 * Deleting an entry is the goal. Adding one needs the same standard of proof:
 * demonstrated failing on a pristine checkout, with the cause understood.
 */
const QUARANTINED_TESTS: readonly string[] = [
	// Times out waiting for a model-cycle state to settle. It fails on an idle
	// container as readily as on a loaded runner, so this is not the load
	// sensitivity AGENTS.md warns about — it is a real pre-existing failure in
	// the inherited suite, quarantined so the other 622 files can gate.
	// Tracked: https://github.com/kelvincushman/orphus/issues/66
	"**/test/unit/interactive-engine-cycle-fallback.test.ts",
];

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
