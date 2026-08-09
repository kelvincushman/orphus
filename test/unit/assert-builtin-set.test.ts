import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { assertExactBuiltinSet, EXPECTED_BUILTIN_DIRECTORY_NAMES } from "../../scripts/assert-builtin-set.js";
import { moduleDir } from "../helpers/runtime.js";

interface BuiltinFixture {
	root: string;
	workspace: string;
}

function withBuiltinEntries(names: readonly string[], run: (fixture: BuiltinFixture) => void): void {
	const workspace = mkdtempSync(join(tmpdir(), "atomic-builtin-set-"));
	const root = join(workspace, "builtin");
	mkdirSync(root);
	try {
		for (const name of names) mkdirSync(join(root, name));
		run({ root, workspace });
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

const exactNameMismatch = /Builtin entry set mismatch/u;
const expectedTypeMismatch = /Builtin entry must be a real, non-link directory/u;

/**
 * The builtin manifest is stated three times: the copier decides what the build
 * puts in the archive, this guard decides what the archive may contain, and the
 * runtime decides what the shipped binary will load. All three must agree, and
 * nothing compared them — #17 added `roundtable` to the copier alone, which left
 * every `build-binaries.sh` run failing with an entry set mismatch until #31.
 * `ci.yml` does not build binaries, so only a pushed tag ever revealed it.
 *
 * Read as source text rather than imported. copy-builtin-packages.ts emits
 * declarations and bundles the workflows extension at module scope with no
 * `import.meta.main` guard, so importing it would run a build; builtin-packages.ts
 * pulls in the agent's config resolution. Neither list is exported.
 */
const WORKSPACE_BUILTINS_BLOCK = /const WORKSPACE_BUILTINS[^=]*=\s*\[(.*?)\](?:\s+as\s+const)?;/su;

function declaredBuiltinNames(relativePath: string, field: "workspaceDirName" | "distDirName"): string[] {
	const source = readFileSync(join(moduleDir(import.meta.url), "../..", relativePath), "utf8");
	const block = WORKSPACE_BUILTINS_BLOCK.exec(source);
	assert.ok(block, `WORKSPACE_BUILTINS is no longer a literal array in ${relativePath}`);
	const names = [...block[1]!.matchAll(new RegExp(`${field}: "([^"]+)"`, "gu"))].map((match) => match[1]!).sort();
	assert.ok(names.length > 0, `parsed no ${field} entries from ${relativePath}`);
	return names;
}

const COPIER = "packages/coding-agent/scripts/copy-builtin-packages.ts";
const RUNTIME = "packages/coding-agent/src/core/builtin-packages.ts";

test("the expected builtin set matches the workspace builtins the build copies", () => {
	assert.deepEqual(declaredBuiltinNames(COPIER, "workspaceDirName"), [...EXPECTED_BUILTIN_DIRECTORY_NAMES]);
});

test("the expected builtin set matches the builtins the shipped runtime loads", () => {
	assert.deepEqual(declaredBuiltinNames(RUNTIME, "distDirName"), [...EXPECTED_BUILTIN_DIRECTORY_NAMES]);
	assert.deepEqual(declaredBuiltinNames(RUNTIME, "workspaceDirName"), [...EXPECTED_BUILTIN_DIRECTORY_NAMES]);
});

test("accepts exactly the supported builtin directory set", () => {
	withBuiltinEntries(EXPECTED_BUILTIN_DIRECTORY_NAMES, ({ root }) => {
		assert.deepEqual(assertExactBuiltinSet(root), [...EXPECTED_BUILTIN_DIRECTORY_NAMES]);
	});
});

test("rejects a missing builtin directory", () => {
	withBuiltinEntries(EXPECTED_BUILTIN_DIRECTORY_NAMES.slice(1), ({ root }) => {
		assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
	});
});

test("rejects an unexpected builtin directory", () => {
	withBuiltinEntries([...EXPECTED_BUILTIN_DIRECTORY_NAMES, "retired-provider"], ({ root }) => {
		assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
	});
});
for (const [label, name] of [
	["regular file", "retired-provider"],
	["hidden file", ".retired-provider"],
] as const) {
	test(`rejects an unexpected ${label}`, () => {
		withBuiltinEntries(EXPECTED_BUILTIN_DIRECTORY_NAMES, ({ root }) => {
			writeFileSync(join(root, name), "unexpected\n");
			assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
		});
	});
}

test("rejects an unexpected directory link or junction", () => {
	withBuiltinEntries(EXPECTED_BUILTIN_DIRECTORY_NAMES, ({ root, workspace }) => {
		const target = join(workspace, "link-target");
		mkdirSync(target);
		symlinkSync(target, join(root, "retired-provider"), process.platform === "win32" ? "junction" : "dir");
		assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
	});
});

test("rejects a case-variant expected directory name", () => {
	const withoutIntercom = EXPECTED_BUILTIN_DIRECTORY_NAMES.filter((name) => name !== "intercom");
	withBuiltinEntries(withoutIntercom, ({ root }) => {
		mkdirSync(join(root, "INTERCOM"));
		assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
	});
});

test("rejects an expected name occupied by a regular file with a type-specific error", () => {
	const withoutIntercom = EXPECTED_BUILTIN_DIRECTORY_NAMES.filter((name) => name !== "intercom");
	withBuiltinEntries(withoutIntercom, ({ root }) => {
		writeFileSync(join(root, "intercom"), "not a directory\n");
		assert.throws(() => assertExactBuiltinSet(root), expectedTypeMismatch);
	});
});

test("rejects an expected name occupied by a directory link or junction", () => {
	const withoutIntercom = EXPECTED_BUILTIN_DIRECTORY_NAMES.filter((name) => name !== "intercom");
	withBuiltinEntries(withoutIntercom, ({ root, workspace }) => {
		const target = join(workspace, "expected-link-target");
		mkdirSync(target);
		symlinkSync(target, join(root, "intercom"), process.platform === "win32" ? "junction" : "dir");
		assert.throws(() => assertExactBuiltinSet(root), expectedTypeMismatch);
	});
});

if (process.platform !== "win32") {
	test("rejects an unexpected file symlink", () => {
		withBuiltinEntries(EXPECTED_BUILTIN_DIRECTORY_NAMES, ({ root, workspace }) => {
			const target = join(workspace, "file-target");
			writeFileSync(target, "target\n");
			symlinkSync(target, join(root, "retired-provider"), "file");
			assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
		});
	});

	test("rejects an unexpected broken symlink", () => {
		withBuiltinEntries(EXPECTED_BUILTIN_DIRECTORY_NAMES, ({ root, workspace }) => {
			symlinkSync(join(workspace, "missing"), join(root, "retired-provider"), "file");
			assert.throws(() => assertExactBuiltinSet(root), exactNameMismatch);
		});
	});

	for (const [label, broken] of [
		["file symlink", false],
		["broken symlink", true],
	] as const) {
		test(`rejects an expected name occupied by a ${label}`, () => {
			const withoutIntercom = EXPECTED_BUILTIN_DIRECTORY_NAMES.filter((name) => name !== "intercom");
			withBuiltinEntries(withoutIntercom, ({ root, workspace }) => {
				const target = join(workspace, broken ? "missing" : "file-target");
				if (!broken) writeFileSync(target, "target\n");
				symlinkSync(target, join(root, "intercom"), "file");
				assert.throws(() => assertExactBuiltinSet(root), expectedTypeMismatch);
			});
		});
	}
}
