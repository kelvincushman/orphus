#!/usr/bin/env bun

/**
 * Cut a release without ever moving the working branch.
 *
 * Atomic keeps `main` versionless: every package manifest (plus the
 * lockfile, the native binding checks, and README badges) sits at the `0.0.0`
 * placeholder. The real version is materialized **only** on a throwaway
 * `Release <version>` commit that is created off the chosen base, tagged as
 * both `<version>` and `v<version>`, and then abandoned. The commit is
 * reachable solely through those tags — it is never merged back into `main`.
 * This mirrors how openai/codex tags releases.
 *
 * Mechanically:
 *   1. validate the version + a clean working tree
 *   2. resolve the current attached branch (or `--base`) to its exact remote branch SHA
 *   3. stamp the real version into the worktree via scripts/bump-version.ts
 *      (including package-lock.json's workspace entries: `npm ci` refuses to
 *      install when the lockfile and a package.json disagree)
 *   4. regenerate release artifacts that must carry the stamped version, including
 *      packages/coding-agent/npm-shrinkwrap.json
 *   5. commit `Release <version>` and tag `<version>` plus `v<version>` inside the worktree
 *   6. remove the worktree — the tag (and its commit) persist in the repo
 *
 * Pushing the public `v<version>` tag starts release.yml, which verifies and
 * stamps the version before building downloadable archives.
 *
 * Usage:
 *   bun run scripts/cut-release.ts <version> [--base <ref>] [--push] [--yes]
 *
 * Examples:
 *   bun run scripts/cut-release.ts 0.8.31
 *   bun run scripts/cut-release.ts 0.9.0-alpha.1
 *   bun run scripts/cut-release.ts 0.8.31 --base main --push
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { canonicalReleaseBaseRef } from "./release-base.js";

const STRICT_RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta)\.([1-9]\d*))?$/;
const PLACEHOLDER_VERSIONS = new Set(["0.0.0", "0.0.0-dev"]);

const ROOT = resolve(import.meta.dir, "..");

interface Options {
	version: string;
	base: string | undefined;
	push: boolean;
	yes: boolean;
}

function parseArgs(): Options {
	const argv = process.argv.slice(2);
	let version: string | undefined;
	let base: string | undefined;
	let push = false;
	let yes = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--base") {
			const candidate = argv[++i];
			if (!candidate || candidate.startsWith("-")) fail("--base requires a canonical remote branch name.");
			base = candidate;
		} else if (arg === "--push") {
			push = true;
		} else if (arg === "--yes" || arg === "-y") {
			yes = true;
		} else if (arg.startsWith("-")) {
			fail(`Unknown flag: ${arg}`);
		} else if (version === undefined) {
			version = arg;
		} else {
			fail(`Unexpected extra argument: ${arg}`);
		}
	}

	if (!version) {
		fail("Usage: bun run scripts/cut-release.ts <version> [--base <ref>] [--push] [--yes]");
	}

	return { version: version as string, base, push, yes };
}

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function validateVersion(version: string): void {
	if (PLACEHOLDER_VERSIONS.has(version)) {
		fail(`"${version}" is the development placeholder and must never be released.`);
	}
	if (!STRICT_RELEASE_VERSION_RE.test(version)) {
		fail(
			`"${version}" is not a valid release version. Expected MAJOR.MINOR.PATCH, MAJOR.MINOR.PATCH-alpha.REVISION, or MAJOR.MINOR.PATCH-beta.REVISION (e.g. 0.8.31, 0.9.0-alpha.1, or 0.9.0-beta.1).`,
		);
	}
}

async function gitText(args: string[], cwd: string = ROOT): Promise<string> {
	return (await $`git -C ${cwd} ${args}`.text()).trim();
}

async function main(): Promise<void> {
	const { version, base, push, yes } = parseArgs();
	validateVersion(version);

	// Refuse to operate on a dirty tree — the worktree is created from committed
	// state, so uncommitted edits would silently be excluded from the release.
	const dirty = await gitText(["status", "--porcelain"]);
	if (dirty) {
		fail("Working tree is not clean. Commit or stash changes before cutting a release.");
	}

	const publicTag = `v${version}`;
	const releaseTags = [version, publicTag];

	// The tags are the release. Never clobber either local or remote state.
	for (const tag of releaseTags) {
		const existingTag = await $`git -C ${ROOT} tag --list ${tag}`.text();
		if (existingTag.trim()) fail(`Tag ${tag} already exists.`);
		const remoteTag = await $`git -C ${ROOT} ls-remote --exit-code --refs origin ${`refs/tags/${tag}`}`
			.nothrow()
			.quiet();
		if (remoteTag.exitCode === 0) fail(`Tag ${tag} already exists on origin.`);
		if (remoteTag.exitCode !== 2) fail(`Could not verify whether tag ${tag} exists on origin.`);
	}

	await $`git -C ${ROOT} worktree prune`.quiet();

	const branch = await gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
	const baseBranch = base ?? branch;
	if (baseBranch === "HEAD") {
		fail("A canonical remote base branch is required when cutting a release from detached HEAD.");
	}
	let baseRef: string;
	try {
		baseRef = canonicalReleaseBaseRef(baseBranch);
	} catch (error) {
		return fail((error as Error).message);
	}
	const remoteBase = await $`git -C ${ROOT} ls-remote --exit-code --refs origin ${baseRef}`.nothrow().quiet();
	if (remoteBase.exitCode !== 0) {
		fail(`Base ref "${baseRef}" does not exist on origin.`);
	}
	const remoteFields = remoteBase.stdout.toString().trim().split(/\s+/u);
	const baseSha = remoteFields[0];
	if (!baseSha || !/^[0-9a-f]{40}$/u.test(baseSha) || remoteFields[1] !== baseRef || remoteFields.length !== 2) {
		fail(`Base ref "${baseRef}" did not resolve to exactly one immutable remote commit.`);
	}

	const name = (await $`git -C ${ROOT} config user.name`.nothrow().text()).trim() || "atomic-release";
	const email =
		(await $`git -C ${ROOT} config user.email`.nothrow().text()).trim() || "atomic-release@users.noreply.github.com";

	console.log(`Cutting release ${version}`);
	console.log(`  base:   ${baseRef} (${baseSha.slice(0, 9)})`);
	console.log(`  branch: ${branch} (left untouched)\n`);

	if (!yes) console.log("Proceeding immediately; pass --yes to suppress this notice.\n");

	const tmpRoot = mkdtempSync(join(tmpdir(), "atomic-release-"));
	const worktreeDir = join(tmpRoot, "wt");
	let worktreeAdded = false;

	try {
		await $`git -C ${ROOT} worktree add --detach ${worktreeDir} ${baseSha}`.quiet();
		worktreeAdded = true;

		// Stamp the real version into the detached worktree only, then regenerate
		// release artifacts that encode the stamped version. The shrinkwrap generator
		// is hermetic: internal Atomic packages use deterministic registry tarball
		// URLs derived from local package metadata rather than npm registry metadata.
		await $`bun run ${join(ROOT, "scripts/bump-version.ts")} ${version} --root ${worktreeDir}`;
		await $`bun run ${join(worktreeDir, "scripts/generate-coding-agent-shrinkwrap.mjs")}`;

		// bump-version.ts also stamps package-lock.json's workspace entries, so the
		// tagged commit installs cleanly with `npm ci`. No relock is needed: only
		// first-party versions changed, which avoids a network round-trip here.
		await $`git -C ${worktreeDir} add -A`;
		const commitMessage = `Release ${version}\n\nRelease-base-ref: ${baseRef}\nRelease-base-sha: ${baseSha}`;
		await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} commit --no-verify -m ${commitMessage}`.quiet();
		// Lightweight tags: the bare tag preserves inherited version lookup; the
		// v-prefixed public tag is what this fork's active release workflow consumes.
		await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} tag ${version}`.quiet();
		await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} tag ${publicTag}`.quiet();
	} finally {
		if (worktreeAdded) {
			await $`git -C ${ROOT} worktree remove --force ${worktreeDir}`.nothrow().quiet();
		}
		rmSync(tmpRoot, { recursive: true, force: true });
	}

	// Sanity-check the tagged tree carries the real version (and main does not).
	const taggedVersion = JSON.parse(
		await $`git -C ${ROOT} show ${`${version}:packages/coding-agent/package.json`}`.text(),
	).version as string;
	if (taggedVersion !== version) {
		fail(`Tagged commit version ${taggedVersion} does not match ${version} — aborting.`);
	}

	const tagSha = await gitText(["rev-list", "-n", "1", version]);
	const publicTagSha = await gitText(["rev-list", "-n", "1", publicTag]);
	if (publicTagSha !== tagSha) {
		fail(`Tags ${version} and ${publicTag} do not point to the same release commit — aborting.`);
	}
	console.log(`\nCreated tags ${version} and ${publicTag} -> ${tagSha.slice(0, 9)} (Release ${version})`);
	console.log(`${branch} stays versionless; the release commit lives only on those tags.\n`);

	if (push) {
		console.log(`Pushing tags ${version} and ${publicTag}...`);
		await $`git -C ${ROOT} push origin ${version} ${publicTag} --atomic`;
		console.log(`Tags pushed. GitHub Actions will build the Orphus archives from ${publicTag}.`);
	} else {
		console.log("Next: push both tags atomically to publish the public release:");
		console.log(`  git push origin ${version} ${publicTag} --atomic`);
	}
}

await main();
