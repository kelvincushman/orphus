import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(root, "scripts/cut-release.ts"), "utf8");

test("cut-release creates bare and public tags on the same stamped commit", () => {
	assert.match(source, /const publicTag = `v\$\{version\}`/u);
	assert.match(source, /const releaseTags = \[version, publicTag\]/u);
	assert.match(source, /tag \$\{version\}[\s\S]*tag \$\{publicTag\}/u);
	assert.match(source, /const publicTagSha = await gitText\(\["rev-list", "-n", "1", publicTag\]\)/u);
	assert.match(source, /publicTagSha !== tagSha/u);
});

test("cut-release refuses either pre-existing tag before creating a release", () => {
	const pruneNeedle = "await $`git -C $" + "{ROOT} worktree prune`";
	const collisionCheck = source.slice(source.indexOf("// The tags are the release"), source.indexOf(pruneNeedle));
	assert.match(collisionCheck, /for \(const tag of releaseTags\)/u);
	assert.match(collisionCheck, /tag --list \$\{tag\}/u);
	assert.match(collisionCheck, /ls-remote --exit-code --refs origin \$\{`refs\/tags\/\$\{tag\}`\}/u);
	assert.match(collisionCheck, /Tag \$\{tag\} already exists on origin/u);
	assert.match(collisionCheck, /remoteTag\.exitCode !== 2/u);
	assert.match(collisionCheck, /Could not verify whether tag \$\{tag\} exists on origin/u);
});

test("cut-release pushes both release refs atomically", () => {
	assert.match(source, /git -C \$\{ROOT\} push origin \$\{version\} \$\{publicTag\} --atomic/u);
	assert.doesNotMatch(source, /git -C \$\{ROOT\} push origin \$\{version\}(?! \$\{publicTag\})/u);
});

function run(command, args, cwd, env = process.env) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
		timeout: 300_000,
	});
	return {
		...result,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function git(cwd, ...args) {
	const result = run("git", args, cwd);
	assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.output}`);
	return result.stdout.trim();
}

test("cut-release is fail-closed in a disposable Git remote", { timeout: 300_000 }, () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "orphus-cut-release-test-"));
	const fixture = join(tempRoot, "fixture");
	const remote = join(tempRoot, "origin.git");
	const bun = process.env.ORPHUS_BUN_EXECUTABLE || "bun";

	try {
		git(tempRoot, "clone", "--no-local", root, fixture);
		git(fixture, "checkout", "-B", "main");
		git(fixture, "config", "user.name", "Orphus release test");
		git(fixture, "config", "user.email", "release-test@localhost");
		copyFileSync(join(root, "scripts/cut-release.ts"), join(fixture, "scripts/cut-release.ts"));
		git(fixture, "add", "scripts/cut-release.ts");
		git(fixture, "commit", "-m", "Use release cutter under test");

		mkdirSync(remote);
		git(remote, "init", "--bare");
		git(fixture, "remote", "set-url", "origin", remote);
		git(fixture, "push", "-u", "origin", "main");

		const releaseEnv = { ...process.env, TMPDIR: tempRoot };
		const first = run(
			bun,
			["run", "scripts/cut-release.ts", "9.8.7", "--base", "main", "--yes"],
			fixture,
			releaseEnv,
		);
		assert.equal(first.status, 0, first.output);
		const bareSha = git(fixture, "rev-list", "-n", "1", "9.8.7");
		assert.equal(git(fixture, "rev-list", "-n", "1", "v9.8.7"), bareSha);
		assert.equal(
			git(fixture, "show", "9.8.7:packages/coding-agent/package.json").includes('"version": "9.8.7"'),
			true,
		);

		const collision = run(
			bun,
			["run", "scripts/cut-release.ts", "9.8.7", "--base", "main", "--yes"],
			fixture,
			releaseEnv,
		);
		assert.notEqual(collision.status, 0);
		assert.match(collision.output, /Tag 9\.8\.7 already exists/u);

		git(fixture, "remote", "set-url", "origin", join(tempRoot, "missing.git"));
		const probeFailure = run(
			bun,
			["run", "scripts/cut-release.ts", "9.8.8", "--base", "main", "--yes"],
			fixture,
			releaseEnv,
		);
		assert.notEqual(probeFailure.status, 0);
		assert.match(probeFailure.output, /Could not verify whether tag 9\.8\.8 exists on origin/u);
		assert.equal(git(fixture, "tag", "--list", "9.8.8", "v9.8.8"), "");

		git(fixture, "remote", "set-url", "origin", remote);
		const hook = join(remote, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o755);
		const rejected = run(
			bun,
			["run", "scripts/cut-release.ts", "9.8.9", "--base", "main", "--push", "--yes"],
			fixture,
			releaseEnv,
		);
		assert.notEqual(rejected.status, 0);
		assert.notEqual(run("git", ["show-ref", "--verify", "--quiet", "refs/tags/9.8.9"], remote).status, 0);
		assert.notEqual(run("git", ["show-ref", "--verify", "--quiet", "refs/tags/v9.8.9"], remote).status, 0);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
