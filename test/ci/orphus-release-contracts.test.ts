import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const releasePath = join(root, ".github/workflows/release.yml");
const readmePath = join(root, "README.md");

test("the Orphus release runs only for version tags and verifies the existing tag", async () => {
	const workflow = await readText(releasePath);
	assert.match(workflow, /push:[\s\S]{0,220}?tags: \["v\*"\]/u);
	assert.doesNotMatch(workflow, /workflow_dispatch/u);
	assert.match(workflow, /gh release create "\$TAG" --verify-tag --draft/u);
});

test("the missing fork LFS payload is fetched from upstream and content-addressed", async () => {
	const workflow = await readText(releasePath);
	assert.doesNotMatch(workflow, /\blfs: true\b/u);
	assert.match(workflow, /git lfs fetch upstream-lfs HEAD --include="\$ASSET" --exclude=''/u);
	assert.match(workflow, /git lfs checkout "\$ASSET"/u);
	assert.match(workflow, /ASSET_SHA256: 169acd0dfe6fbb8d8742ed24a3fc654fd0b2e2d4223c733249c5493723f1b72d/u);
	assert.match(workflow, /sha256sum "\$ASSET"/u);
});

test("release builds cannot inherit the write-capable checkout credential", async () => {
	const workflow = await readText(releasePath);
	assert.match(
		workflow,
		/actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n(?:\s+[^\n]+\n)*?\s+persist-credentials: false/u,
	);
});

test("the tag version is stamped and proven by the packaged Orphus executable", async () => {
	const workflow = await readText(releasePath);
	assert.match(workflow, /VERSION="\$\{TAG#v\}"/u);
	assert.match(workflow, /\[\[ "\$VERSION" != "0\.0\.0" \]\]/u);
	assert.match(workflow, /bun run scripts\/bump-version\.ts "\$VERSION"/u);
	assert.match(workflow, /build-binaries\.sh --skip-deps --skip-install --platform linux-x64/u);
	assert.match(workflow, /mv release\/atomic release\/orphus/u);
	assert.match(workflow, /mv release\/orphus\/atomic release\/orphus\/orphus/u);
	assert.match(workflow, /test "\$\(release\/orphus\/orphus --version\)" = "\$VERSION"/u);
	assert.match(workflow, /orphus-linux-x64\.tar\.gz orphus-windows-x64\.zip SHA256SUMS/u);
	assert.doesNotMatch(workflow, /gh release create[^\n]*[\s\S]{0,200}?atomic-linux-x64/u);
});

test("the darwin arm64 archive is host-built, renamed, verified, and staged beside linux and windows", async () => {
	const workflow = await readText(releasePath);
	assert.match(workflow, /runs-on: macos-15/u);
	assert.match(workflow, /build-binaries\.sh --skip-deps --skip-install --platform darwin-arm64/u);
	assert.match(workflow, /NATIVE_TARGET: aarch64-apple-darwin/u);
	assert.match(workflow, /shasum -a 256 "\$ASSET"/u);
	assert.match(workflow, /file release\/orphus\/orphus \| grep -q arm64/u);
	// The darwin job must never grow the linux cross-toolchain: the host build
	// IS the target, and zig/cargo-zigbuild there would only obscure that.
	const darwinJob = workflow.slice(workflow.indexOf("build-darwin:"), workflow.indexOf("\n  release:"));
	assert.doesNotMatch(darwinJob, /setup-zig|cargo-zigbuild@|CROSS_TARGET:|GLIBC_FLOOR/u);
	assert.match(workflow, /needs: \[build-linux, build-darwin, build-windows\]/u);
	assert.match(workflow, /orphus-darwin-arm64\.tar\.gz orphus-linux-x64\.tar\.gz orphus-windows-x64\.zip SHA256SUMS/u);
});

test("the windows x64 archive is host-built, renamed, verified, and staged", async () => {
	const workflow = await readText(releasePath);
	const windowsJob = workflow.slice(workflow.indexOf("build-windows:"), workflow.indexOf("\n  release:"));
	assert.match(windowsJob, /runs-on: windows-latest/u);
	assert.match(windowsJob, /sha256sum "\$ASSET"/u);
	assert.match(windowsJob, /build-binaries\.sh --skip-deps --skip-install --platform windows-x64/u);
	assert.match(windowsJob, /Expand-Archive -Path atomic-windows-x64\.zip -DestinationPath release\/orphus/u);
	assert.match(windowsJob, /Rename-Item -Path release\/orphus\/atomic\.exe -NewName orphus\.exe/u);
	assert.match(windowsJob, /& \.\/release\/orphus\/orphus\.exe --version/u);
	assert.match(windowsJob, /Compress-Archive -Path release\/orphus -DestinationPath orphus-windows-x64\.zip -Force/u);
	assert.match(workflow, /name: orphus-windows-x64/u);
	assert.match(workflow, /path: packages\/coding-agent\/binaries\/orphus-windows-x64\.zip/u);
	assert.doesNotMatch(workflow, /gh release create[^\n]*[\s\S]{0,200}?atomic-windows-x64/u);
});

test("the release glibc contract is wired, measured across every ELF file, and stated coherently", async () => {
	const workflow = await readText(releasePath);
	const readme = await readText(readmePath);
	assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /GLIBC_FLOOR: "2\.17"/u);
	assert.match(workflow, /CROSS_TARGET: x86_64-unknown-linux-gnu\.\$\{\{ env\.GLIBC_FLOOR \}\}/u);
	assert.match(workflow, /tool: cargo-zigbuild@0\.23\.0/u);
	assert.match(workflow, /find release\/orphus -type f/u);
	assert.match(workflow, /-perm -111/u);
	assert.match(workflow, /-name '\*\.so\.\*'/u);
	assert.match(workflow, /test "\$highest_glibc" = "GLIBC_2\.27"/u);
	assert.doesNotMatch(workflow, /Not glibc-floored/u);
	assert.match(workflow, /requires glibc 2\.27 or newer/iu);
	assert.match(readme, /find orphus -type f/u);
	assert.match(readme, /-perm -111/u);
	assert.match(readme, /-name '\*\.so\.\*'/u);
});
