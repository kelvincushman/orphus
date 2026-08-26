import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { extensionLoaderTestHooks } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.ts";

test("loads the subagents extension when installed code imports roundtable bounded rendering", async () => {
	const root = mkdtempSync(join(tmpdir(), "orphus-installed-roundtable-alias-"));
	const previousPackageDir = process.env.ORPHUS_PACKAGE_DIR;
	try {
		const boundedRender = join(root, "builtin", "roundtable", "bounded-render.ts");
		mkdirSync(join(root, "builtin", "subagents", "src", "extension"), { recursive: true });
		mkdirSync(join(root, "builtin", "roundtable"), { recursive: true });
		copyFileSync("packages/roundtable/bounded-render.ts", boundedRender);
		process.env.ORPHUS_PACKAGE_DIR = root;

		const resolved = extensionLoaderTestHooks.resolveRoundtableBoundedRenderEntry(
			join(root, "builtin", "subagents", "src", "extension"),
		);
		const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(
			resolve("packages/subagents/src/extension/index.ts"),
		);

		assert.equal(resolved, boundedRender);
		assert.equal(existsSync(resolved), true);
		assert.equal(typeof factory, "function");
	} finally {
		if (previousPackageDir === undefined) {
			delete process.env.ORPHUS_PACKAGE_DIR;
		} else {
			process.env.ORPHUS_PACKAGE_DIR = previousPackageDir;
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
