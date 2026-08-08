import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const releasePath = join(root, ".github/workflows/release.yml");

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
	assert.match(workflow, /orphus-linux-x64\.tar\.gz SHA256SUMS/u);
	assert.doesNotMatch(workflow, /gh release create[^\n]*[\s\S]{0,200}?atomic-linux-x64/u);
});
