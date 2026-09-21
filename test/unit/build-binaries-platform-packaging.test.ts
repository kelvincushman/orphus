import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const buildScriptPath = join(root, "scripts/build-binaries.sh");

test("musl archive staging removes embedded-postgres binary leaves", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");
	const stagingBlock = buildScript.slice(
		buildScript.indexOf('cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"'),
		buildScript.indexOf('atomic_native="$(atomic_native_filename "$platform")'),
	);

	assert.match(stagingBlock, /if \[\[ "\$platform" == linux-\*-musl \]\]; then/u);
	assert.match(stagingBlock, /rm -rf "binaries\/\$platform\/node_modules\/@embedded-postgres"/u);
	assert.doesNotMatch(stagingBlock, /rm -rf "binaries\/\$platform\/node_modules\/embedded-postgres"/u);

	const syntax = spawnSync("bash", ["-n", buildScriptPath], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
});

test("x64 Linux compiles against Bun's baseline runtime, other platforms do not", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");

	// A literal `--target=bun-$platform` is the regression: it silently routes
	// x64 Linux back to the AVX2 runtime, which no CI runner can detect because
	// every runner has AVX2.
	assert.doesNotMatch(buildScript, /--target=bun-\$platform/u);
	assert.equal(buildScript.match(/--target="\$compile_target"/gu)?.length, 2);

	// Run the real mapping rather than asserting on its source text — the target
	// string each platform resolves to is the whole behaviour under test.
	const mapping = buildScript.slice(
		buildScript.indexOf("bun_compile_target() {"),
		buildScript.indexOf("for platform in"),
	);
	assert.ok(mapping.length > 0, "bun_compile_target is missing from the build script");
	const platforms = [
		"darwin-arm64",
		"darwin-x64",
		"linux-x64",
		"linux-arm64",
		"linux-x64-musl",
		"linux-arm64-musl",
		"windows-x64",
		"windows-arm64",
	];
	const probe = spawnSync(
		"bash",
		["-c", `${mapping}\nfor p in ${platforms.join(" ")}; do echo "$p $(bun_compile_target "$p")"; done`],
		{ encoding: "utf8" },
	);
	assert.equal(probe.status, 0, probe.stderr);
	const resolved = Object.fromEntries(
		probe.stdout
			.trim()
			.split("\n")
			.map((line) => line.split(" ")),
	);

	// AVX2 arrived with Haswell in 2013; older CPUs die with SIGILL before user
	// code runs, which is how the published archive behaved on a Sandy Bridge Xeon.
	assert.equal(resolved["linux-x64"], "bun-linux-x64-baseline");
	assert.equal(resolved["linux-x64-musl"], "bun-linux-x64-musl-baseline");

	// Everything else keeps its stock target; arm64 has no baseline variant and
	// mapping one would fail the build outright.
	assert.equal(resolved["darwin-arm64"], "bun-darwin-arm64");
	assert.equal(resolved["darwin-x64"], "bun-darwin-x64");
	assert.equal(resolved["linux-arm64"], "bun-linux-arm64");
	assert.equal(resolved["linux-arm64-musl"], "bun-linux-arm64-musl");
	assert.equal(resolved["windows-x64"], "bun-windows-x64");
	assert.equal(resolved["windows-arm64"], "bun-windows-arm64");
});
