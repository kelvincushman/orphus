import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import { jobBlock, jobBlocks, readText } from "./workflow-text.js";

/**
 * Contracts for `.github/workflows/ci.yml` — the gate that actually runs.
 *
 * Four contract suites in this directory exhaustively pin `test.yml` and
 * `publish.yml`, both of which are disabled at the repository level. The one
 * workflow whose result decides whether a pull request can merge had no
 * contract of its own: `ci.yml` appeared in `ci-workflow-contracts.test.ts`
 * only inside a comment. Every assertion below exists because removing the
 * thing it names would silently shrink the gate while leaving it green.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const ciPath = join(root, ".github/workflows/ci.yml");

test("CodeRabbit cannot silently narrow the final gate to an allowlist", async () => {
	const config = parseYaml(await readText(join(root, ".coderabbit.yaml"))) as {
		reviews?: { path_filters?: string[] };
	};
	const filters = config.reviews?.path_filters ?? [];
	assert.deepEqual(
		filters,
		["!archive/upstream/**", "!**/*.generated.ts", "!**/node_modules/**"],
		"path filters must remain exclusion-only and limited to known generated or vendored files",
	);
});

test("the Orphus gate lints, typechecks, and verifies the shrinkwrap", async () => {
	const verify = jobBlock(await readText(ciPath), "verify", "suites");
	// `npm run check` is biome --error-on-warnings + tsc --noEmit + the
	// shrinkwrap check. None of the three ran in CI before; they were enforced
	// only by prek hooks a `npm ci` clone never installs.
	assert.match(verify, /run: npm run check\b/u);
});

test("the Orphus gate typechecks the binary's own source", async () => {
	const verify = jobBlock(await readText(ciPath), "verify", "suites");
	// The root tsconfig.json excludes packages/coding-agent, so `npm run check`
	// cannot see it. Upstream covered it with this build inside test.yml's
	// `suites` job — which this fork disabled. Without the step, the package the
	// rebrand touched most heavily is typechecked by nothing.
	assert.match(verify, /working-directory: packages\/coding-agent\n\s+run: npm run build/u);
});

test("the Orphus gate runs the inherited unit suite and the CI contracts", async () => {
	const suites = jobBlock(await readText(ciPath), "suites");
	// The unit suite runs through the flake wrapper so the duration gate and
	// the .ci-diagnostics upload are real, not just described. The wrapper must
	// end in `npm run test:unit` — that one-script indirection is how it finds
	// the vitest config whose budget it enforces.
	assert.match(suites, /run-flaky-test-suite\.ts[\s\S]*?-- npm run test:unit\b/u);
	assert.match(suites, /run: npm run test:ci-contracts\b/u);
	// Integration and script suites are enforced here too — green on this fork
	// and cheap. The workspace suite is deliberately absent (rebrand-stale
	// assertions, LFS fixtures the fork cannot fetch); do not add it without
	// making it green first.
	assert.match(suites, /run-flaky-test-suite\.ts[\s\S]*?-- npm run test:integration\b/u);
	assert.match(suites, /ORPHUS_REQUIRE_INSTALLED_NODE_SMOKE: "1"/u);
	assert.match(suites, /run: npm run test:scripts\b/u);
	// The unit suite imports the bundled subagent extension, which loads the
	// Rust control plane in crates/atomic-natives. Without a binding the import
	// fails and the whole suite dies, not just the runner tests.
	assert.match(suites, /npm run build --workspace=@orphus\/natives/u);
	// test/unit/pi-0.82.1-artifacts.test.ts degrades to test.skip when
	// packages/coding-agent/dist is absent — coverage would vanish, silently.
	assert.match(suites, /working-directory: packages\/coding-agent\n\s+run: npm run build/u);
	// The fork has no tags, but changelog immutability is anchored to Atomic's
	// inherited release tags. Fetch them instead of quarantining that test file.
	assert.match(
		suites,
		/git fetch --no-tags https:\/\/github\.com\/bastani-inc\/atomic\.git 'refs\/tags\/\*:refs\/tags\/\*'/u,
	);
	assert.doesNotMatch(suites, /lfs:\s*true/u);
});

test("the demo runs as an assertion, not as a smoke test", async () => {
	const ci = await readText(ciPath);
	assert.match(ci, /run: bun packages\/roundtable\/demo\/run-demo\.ts/u);
	// The demo measures the late-joiner ratio, PLAN.md's phase-1 exit criterion.
	// It has to be able to fail: CI invoking it proves nothing if the script
	// always exits 0. This asserts the ceiling is declared and enforced at the
	// source, since the workflow step itself can only ever check an exit code.
	const demo = await readText(join(root, "packages/roundtable/demo/run-demo.ts"));
	assert.match(demo, /const LATE_JOINER_BUDGET_RATIO = 0\.4;/u);
	assert.match(demo, /ratio > LATE_JOINER_BUDGET_RATIO[\s\S]{0,400}?process\.exit\(1\)/u);
	// A digest that kept nothing would score 0% and pass a ratio check alone.
	assert.match(demo, /verbatim < 1[\s\S]{0,300}?process\.exit\(1\)/u);
});

test("every Orphus gate job pins its actions by commit SHA", async () => {
	const ci = await readText(ciPath);
	const uses = [...ci.matchAll(/uses: (\S+)/gu)].map(([, ref]) => ref as string);
	assert.ok(uses.length > 0, "expected the gate to use at least one action");
	// A moving tag is a supply-chain hole that every inherited workflow already
	// closes; this one used floating @v5 refs while being the only workflow that
	// runs. Dependabot's github-actions ecosystem is what moves these pins now.
	const floating = uses.filter((ref) => !/@[0-9a-f]{40}$/u.test(ref));
	assert.deepEqual(floating, []);
});

test("checkout credentials are not persisted into repository-controlled steps", async () => {
	const ci = await readText(ciPath);
	for (const [name, block] of jobBlocks(ci)) {
		// A job that never checks out has no credentials to persist, so the rule
		// is scoped to jobs that do. It is the same guarantee, not a weaker one:
		// what must never happen is a checkout leaving a usable token behind for
		// later steps. `review-gate` is the first checkout-less job here — it
		// only calls the GitHub API with the workflow token.
		if (!/actions\/checkout@/u.test(block)) continue;
		assert.match(
			block,
			/actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials: false/u,
			`job ${name} leaves checkout credentials available to later commands`,
		);
	}
});

test("the Orphus gate cancels superseded runs and bounds every job", async () => {
	const ci = await readText(ciPath);
	assert.match(ci, /^concurrency:\n\s+group:.*\n\s+cancel-in-progress: true$/mu);
	for (const [name, block] of jobBlocks(ci)) {
		assert.match(block, /timeout-minutes: \d+/u, `job ${name} declares no timeout`);
	}
});

test("the Orphus gate selects a vitest project rather than restating a timeout", async () => {
	const ci = await readText(ciPath);
	// Same rule the inherited contracts enforce on the test:* scripts: the
	// per-test budget is declared once in vitest.config.ts. A --timeout here
	// would silently override it for the only suite anyone runs.
	assert.doesNotMatch(ci, /--timeout\b/u);
	assert.match(ci, /vitest --run --project unit test\/unit\/roundtable-/u);
});

test("the quarantine list stays small, justified, and visible", async () => {
	const config = (await import("../../vitest.config.js")) as { QUARANTINED_TESTS: readonly string[] };
	const quarantined = config.QUARANTINED_TESTS;

	// Empty since the last entry was diagnosed (issue #66: runner provider
	// credentials leaking into the fixture's model world — a test-harness bug,
	// not an engine one). This assertion exists so growing the list is a
	// deliberate act that shows up in review rather than a quiet way to make CI
	// green; shrinking it is the goal and gets celebrated the same way.
	assert.deepEqual([...quarantined].sort(), []);

	// Each entry must carry its reason in the config, next to the entry itself —
	// a bare list of paths decays into folklore about why they are there.
	const source = await readText(join(root, "vitest.config.ts"));
	for (const entry of quarantined) {
		const file = entry.replace("**/", "");
		const index = source.indexOf(entry);
		assert.ok(index > 0, `${file} is not listed in vitest.config.ts`);
		const preceding = source.slice(Math.max(0, index - 600), index);
		assert.match(preceding, /\/\/ .+/u, `${file} is quarantined with no stated reason`);
	}
});

test("diagnostics upload survives failures but not workflow cancellation", async () => {
	const suites = jobBlock(await readText(ciPath), "suites");
	assert.match(suites, /name: Upload test diagnostics\n\s+if: \$\{\{ !cancelled\(\) \}\}/u);
	assert.doesNotMatch(suites, /if: always\(\)/u);
});

test("quarantined tests are excluded from collection, not skipped inside their files", async () => {
	const config = (await import("../../vitest.config.js")) as {
		QUARANTINED_TESTS: readonly string[];
		default: { test?: { projects?: { test?: { exclude?: string[] } }[] } };
	};
	// A soft guard inside a test keeps its name in the pass count while its
	// assertions do nothing — the exact failure mode the SQLite contract in
	// ci-workflow-contracts.test.ts exists to prevent. Excluding at collection
	// makes the file's absence countable instead.
	for (const project of config.default.test?.projects ?? []) {
		for (const entry of config.QUARANTINED_TESTS) {
			assert.ok(project.test?.exclude?.includes(entry), `project does not exclude ${entry}`);
		}
	}
});
