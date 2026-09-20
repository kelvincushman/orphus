import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Node builtins that a bare `require()` can name. Extending this list is
 * cheaper than a regex over every possible specifier, and a builtin missing
 * from it fails open rather than falsely accusing a real dependency.
 */
const BUILTINS = [
	"assert",
	"buffer",
	"child_process",
	"crypto",
	"events",
	"fs",
	"fs/promises",
	"http",
	"https",
	"module",
	"net",
	"os",
	"path",
	"process",
	"readline",
	"stream",
	"tty",
	"url",
	"util",
	"worker_threads",
	"zlib",
];

const BARE_BUILTIN_REQUIRE = new RegExp(String.raw`\brequire\(\s*["'](${BUILTINS.join("|")})["']\s*\)`, "u");

/**
 * Only code that can end up inside a tsx-namespaced extension graph is at risk,
 * so tests, demos and eval harnesses are out of scope — they run under vitest's
 * or Bun's own pipeline and never reach the extension loader. `examples/` stays
 * in scope precisely because users copy those files into real extensions.
 */
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"native",
	"npm",
	"target",
	".git",
	"test",
	"tests",
	"demo",
	"evals",
	"scripts",
]);

async function shippedSourceFiles(dir: string, found: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await shippedSourceFiles(full, found);
		} else if ([".ts", ".tsx", ".mts", ".cts"].includes(extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
			found.push(full);
		}
	}
	return found;
}

/**
 * A bare `require("fs")` in shipped source breaks every extension load on
 * Node >= 22.22.3.
 *
 * tsx's extension loader registers its hooks under a namespace, which it
 * carries by appending `?tsx-namespace=...` to resolved URLs. From 22.22.3 Node
 * switched tsx onto `module.registerHooks()` — synchronous hooks that also run
 * for CJS `require()` — and on that path Node's CJS resolver returns no
 * `format` for a *bare* builtin, so tsx's `format === "builtin"` guard misses
 * and the namespace lands on the specifier. `node:fs?tsx-namespace=...` is then
 * read as a file path: ENOENT, and every builtin extension fails to load.
 *
 * A `node:`-prefixed require is guarded by specifier and never reaches that
 * path. The whole codebase already spells builtins that way; one file did not,
 * and it was enough to break the loader on CI while passing on a developer
 * machine one patch version behind.
 *
 * This is the only model-free way to assert it below 22.22.3, where the bug is
 * invisible. `node-version: 22` in CI floats, so CI itself is the other half of
 * the check — but it only reports after a push, and it cannot say why.
 */
test("shipped source requires builtins by their node: specifier", async () => {
	const offenders: string[] = [];
	for (const file of await shippedSourceFiles(join(root, "packages"))) {
		const source = await readFile(file, "utf8");
		const match = BARE_BUILTIN_REQUIRE.exec(source);
		if (match) offenders.push(`${relative(root, file)} — ${match[0]}`);
	}

	assert.deepEqual(
		offenders,
		[],
		`Bare builtin require() in shipped source. Use require("node:<name>") instead:\n  ${offenders.join("\n  ")}`,
	);
});
