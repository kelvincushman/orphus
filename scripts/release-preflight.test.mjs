import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, cwd, env = process.env) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: 120_000 });
	return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function git(cwd, ...args) {
	const result = run("git", args, cwd);
	assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.output}`);
	return result.stdout.trim();
}

function write(fixture, relativePath, contents) {
	const target = join(fixture, relativePath);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, contents);
}

function commit(fixture, message) {
	git(fixture, "add", "-A");
	git(fixture, "commit", "--no-verify", "-q", "-m", message);
	return git(fixture, "rev-parse", "HEAD");
}

function preflight(fixture, ...args) {
	const bun = process.env.ORPHUS_BUN_EXECUTABLE || "bun";
	return run(bun, ["run", "scripts/release-preflight.ts", ...args], fixture);
}

/**
 * A throwaway repository shaped like this one: a versionless `main`, and a
 * release tag on a detached `Release <version>` commit that is NOT an ancestor
 * of main and carries the base trailers `cut-release.ts` writes. The script
 * under test resolves its repository from its own location, so the two scripts
 * it needs are copied in rather than the whole tree being cloned.
 */
function buildFixture() {
	const tempRoot = mkdtempSync(join(tmpdir(), "orphus-release-preflight-"));
	const fixture = join(tempRoot, "work");
	const remote = join(tempRoot, "origin.git");

	mkdirSync(remote, { recursive: true });
	git(remote, "init", "--bare", "-q");
	mkdirSync(fixture, { recursive: true });
	git(fixture, "init", "-q", "-b", "main");
	git(fixture, "config", "user.name", "Orphus preflight test");
	git(fixture, "config", "user.email", "preflight-test@localhost");
	git(fixture, "remote", "add", "origin", remote);

	mkdirSync(join(fixture, "scripts"), { recursive: true });
	for (const script of ["release-preflight.ts", "release-base.ts"]) {
		cpSync(join(root, "scripts", script), join(fixture, "scripts", script));
	}
	write(fixture, "packages/demo/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- First release\n");
	write(fixture, "packages/demo/index.ts", "export const value = 1;\n");
	const baseSha = commit(fixture, "Base for the previous release");
	git(fixture, "push", "-q", "-u", "origin", "main");

	// The release commit lives off to one side, exactly as cut-release leaves it.
	git(fixture, "checkout", "-q", "--detach", baseSha);
	git(
		fixture,
		"commit",
		"--no-verify",
		"-q",
		"--allow-empty",
		"-m",
		`Release 1.0.0\n\nRelease-base-ref: refs/heads/main\nRelease-base-sha: ${baseSha}`,
	);
	git(fixture, "tag", "v1.0.0");
	git(fixture, "checkout", "-q", "main");

	return { tempRoot, fixture };
}

test("release-preflight fails a package change with no Unreleased entries, and passes once they exist", () => {
	const { tempRoot, fixture } = buildFixture();
	try {
		write(fixture, "packages/demo/index.ts", "export const value = 2;\n");
		commit(fixture, "Change shipped behaviour");
		git(fixture, "push", "-q", "origin", "main");

		const missing = preflight(fixture);
		assert.notEqual(missing.status, 0, missing.output);
		assert.match(
			missing.output,
			/packages\/demo changed but packages\/demo\/CHANGELOG\.md has no \[Unreleased\] entries/u,
		);

		write(
			fixture,
			"packages/demo/CHANGELOG.md",
			"# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Value is now 2\n\n## [1.0.0]\n\n- First release\n",
		);
		commit(fixture, "Record the change");
		git(fixture, "push", "-q", "origin", "main");

		const recorded = preflight(fixture);
		assert.equal(recorded.status, 0, recorded.output);
		assert.match(recorded.output, /Ready to release from origin\/main/u);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("release-preflight fails when an expected commit is not on the base", () => {
	const { tempRoot, fixture } = buildFixture();
	try {
		git(fixture, "checkout", "-q", "-b", "feature");
		write(fixture, "packages/demo/docs/guide.md", "Documented.\n");
		const featureSha = commit(fixture, "Work that was never merged");
		git(fixture, "push", "-q", "-u", "origin", "feature");
		git(fixture, "checkout", "-q", "main");

		const unmerged = preflight(fixture, "--expect", featureSha);
		assert.notEqual(unmerged.status, 0, unmerged.output);
		assert.match(unmerged.output, /is not an ancestor of origin\/main\. Its pull request is not merged\./u);

		// The same commit passes once the base actually carries it.
		git(fixture, "merge", "-q", "--no-edit", "feature");
		git(fixture, "push", "-q", "origin", "main");
		const merged = preflight(fixture, "--expect", featureSha);
		assert.equal(merged.status, 0, merged.output);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("release-preflight does not demand a changelog entry for a documentation-only package change", () => {
	const { tempRoot, fixture } = buildFixture();
	try {
		write(fixture, "packages/demo/docs/guide.md", "Documented.\n");
		write(fixture, "packages/demo/README.md", "Demo.\n");
		commit(fixture, "Document the package");
		git(fixture, "push", "-q", "origin", "main");

		const docsOnly = preflight(fixture);
		assert.equal(docsOnly.status, 0, docsOnly.output);
		assert.doesNotMatch(docsOnly.output, /packages\/demo changed but/u);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("release-preflight refuses a base with nothing new since the last release", () => {
	const { tempRoot, fixture } = buildFixture();
	try {
		const unchanged = preflight(fixture);
		assert.notEqual(unchanged.status, 0, unchanged.output);
		assert.match(unchanged.output, /has no commits since v1\.0\.0 .* — nothing to release/u);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
