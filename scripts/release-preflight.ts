#!/usr/bin/env bun

/**
 * Prove a release base is ready before `publish-release` touches it.
 *
 * The `publish-release` workflow requires a changelog-only diff, so everything
 * else a release needs — the docs, the README, the `[Unreleased]` entries —
 * must already be on the base when it starts. Nothing checked that, and
 * nothing checked that the base actually contains the work being announced: a
 * 2.2.0 release was nearly cut from a base whose feature PR was still open,
 * because "I merged it" was taken at its word.
 *
 * This reports the facts and exits non-zero when one of them is wrong:
 *   - the base carries commits since the last release tag (there is something to ship)
 *   - every `--expect <ref>` is an ancestor of the base (the work is actually in)
 *   - every package changed since that tag has entries under `[Unreleased]`
 *
 * It also warns — without failing — when packages changed but no doc or README
 * did. Whether a doc is now misleading is a judgement call a script cannot
 * make; naming the gap is the most it can honestly do.
 *
 * Usage:
 *   bun run scripts/release-preflight.ts [--base <ref>] [--since <tag>] [--expect <ref>]...
 *
 * Examples:
 *   bun run scripts/release-preflight.ts
 *   bun run scripts/release-preflight.ts --base main --expect 35fbf45
 */

import { resolve } from "node:path";
import { $ } from "bun";
import { parseReleaseBaseTrailers } from "./release-base.js";

const ROOT = resolve(import.meta.dir, "..");

/**
 * A path inside a package whose change never by itself obliges a changelog
 * entry. Documentation-only work is infrastructure under the Changelog scope
 * rules in CLAUDE.md, so a package whose whole diff is docs is not "changed"
 * for this check.
 */
function isDocumentationOnly(pathInPackage: string): boolean {
	return pathInPackage === "CHANGELOG.md" || pathInPackage === "README.md" || pathInPackage.startsWith("docs/");
}

/** A change under any of these answers the "did anything get documented?" question. */
const DOC_PATHS = ["README.md", "docs/", "packages/coding-agent/docs/"];

async function git(args: string[]): Promise<string> {
	return (await $`git -C ${ROOT} ${args}`.text()).trim();
}

async function gitOk(args: string[]): Promise<boolean> {
	return (await $`git -C ${ROOT} ${args}`.nothrow().quiet()).exitCode === 0;
}

/**
 * A fetch whose failure is fatal. Suppressing it would leave the later checks
 * reading whatever refs this checkout happened to have, and report a release as
 * ready from stale data — the one thing this script exists to prevent.
 */
async function fetchOrFail(args: string[], what: string): Promise<void> {
	const result = await $`git -C ${ROOT} fetch ${args}`.nothrow().quiet();
	if (result.exitCode === 0) return;
	throw new Error(
		[
			`Could not fetch ${what} from origin, so every ref below would be whatever this checkout already had.`,
			"Check the branch name and that origin is reachable. git said:",
			result.stderr.toString().trim() || "(no output)",
		].join("\n"),
	);
}

/** A package changelog as it exists on the base, or "" when the base has no such file. */
async function changelogAt(baseSha: string, name: string): Promise<string> {
	const shown = await $`git -C ${ROOT} show ${`${baseSha}:packages/${name}/CHANGELOG.md`}`.nothrow().quiet();
	return shown.exitCode === 0 ? shown.stdout.toString() : "";
}

function parseArgs(argv: string[]): { base: string; since?: string; expect: string[] } {
	const expect: string[] = [];
	let base = "main";
	let since: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--base" || flag === "--since" || flag === "--expect") {
			if (!value) throw new Error(`${flag} needs a value`);
			if (flag === "--base") base = value;
			else if (flag === "--since") since = value;
			else expect.push(value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${flag}`);
	}
	return { base, since, expect };
}

/**
 * Where the last release was cut from — which is not the tag itself.
 *
 * A release tag points at a detached `Release <version>` commit that is never
 * merged back, so it is not an ancestor of the base and `git describe` cannot
 * see it. What the range needs is the base commit that release was stamped
 * from, which `cut-release.ts` records on the release commit as
 * `Release-base-sha`.
 */
async function newestOriginReleaseTag(): Promise<string | undefined> {
	const remote = await git(["ls-remote", "--tags", "--refs", "origin", "v*"]);
	const onOrigin = new Set(
		remote
			.split("\n")
			.map((line) => line.split("refs/tags/")[1])
			.filter((name): name is string => name !== undefined && name.length > 0),
	);
	// Ask git for the version ordering, then take the newest tag origin also has.
	const ordered = (await git(["tag", "--list", "v*", "--sort=-v:refname"])).split("\n").filter(Boolean);
	return ordered.find((tag) => onOrigin.has(tag));
}

async function resolveSincePoint(): Promise<{ ref: string; label: string }> {
	await fetchOrFail(["--tags", "--quiet", "origin"], "tags");
	// Local tags are not evidence of a release. `cut-release.ts` tags in this
	// checkout and only publishes with `--push`, so a dry run leaves a higher
	// version behind that origin never saw; measuring the range from it would
	// report the work of a release that does not exist as already shipped.
	const tag = await newestOriginReleaseTag();
	if (!tag) {
		throw new Error(
			[
				"Origin has no v* tag, so there is no range to check.",
				"A shallow clone carries no tags locally: run `git fetch --unshallow --tags origin`.",
				"If this really is the first release, pass the starting point with --since <ref>.",
			].join("\n"),
		);
	}
	const message = await git(["log", "-1", "--format=%B", tag]);
	try {
		const { baseSha } = parseReleaseBaseTrailers(message);
		return { ref: baseSha, label: `${tag} (cut from ${baseSha.slice(0, 9)})` };
	} catch {
		// A tag made by hand carries no trailers. Its own commit is the best
		// available starting point; say so rather than reporting a bogus range.
		return { ref: tag, label: `${tag} (no release-base trailers; using the tag itself)` };
	}
}

/** Entries under `## [Unreleased]`, stopping at the next version heading. */
function unreleasedEntries(text: string): string[] {
	const start = text.search(/^## \[Unreleased\]/mu);
	if (start === -1) return [];
	const rest = text.slice(start).replace(/^## \[Unreleased\][^\n]*\n/u, "");
	const end = rest.search(/^## \[/mu);
	const section = end === -1 ? rest : rest.slice(0, end);
	return section
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "));
}

function packagesTouched(files: string[]): Map<string, string[]> {
	const touched = new Map<string, string[]>();
	for (const file of files) {
		const match = /^packages\/([^/]+)\/(.+)$/u.exec(file);
		if (!match) continue;
		const [, name, rest] = match;
		if (isDocumentationOnly(rest)) continue;
		const existing = touched.get(name);
		if (existing) existing.push(file);
		else touched.set(name, [file]);
	}
	return touched;
}

async function main(): Promise<void> {
	const { base, since, expect } = parseArgs(process.argv.slice(2));

	// The explicit refspec matters: a bare `fetch origin <base>` is only
	// guaranteed to move FETCH_HEAD, and it is `origin/<base>` that is read below.
	await fetchOrFail(["--quiet", "origin", `refs/heads/${base}:refs/remotes/origin/${base}`], `origin/${base}`);
	const baseSha = await git(["rev-parse", `origin/${base}`]);
	const sincePoint = since ? { ref: since, label: since } : await resolveSincePoint();
	const sinceRef = sincePoint.ref;
	// `a..b` yields a range for any two commits, related or not. An unrelated
	// starting point — a trailer pointing at rewritten history, a mistyped
	// `--since` — would silently measure against the wrong history rather than
	// fail, and every check below reads that range.
	if (!(await gitOk(["rev-parse", "--verify", `${sinceRef}^{commit}`]))) {
		throw new Error(`The release starting point ${sinceRef} does not resolve to a commit in this checkout.`);
	}
	if (!(await gitOk(["merge-base", "--is-ancestor", sinceRef, baseSha]))) {
		throw new Error(
			`The release starting point ${sinceRef} is not an ancestor of origin/${base}, so the range would span unrelated history.`,
		);
	}

	const failures: string[] = [];
	const warnings: string[] = [];

	console.log(`Base:  origin/${base} @ ${baseSha.slice(0, 9)}`);
	console.log(`Since: ${sincePoint.label}\n`);

	// 1. Is there anything to release?
	const log = await git(["log", "--oneline", `${sinceRef}..${baseSha}`]);
	const commits = log ? log.split("\n") : [];
	console.log(`Commits since that point: ${commits.length}`);
	for (const commit of commits.slice(0, 15)) console.log(`  ${commit}`);
	if (commits.length > 15) console.log(`  …and ${commits.length - 15} more`);
	if (commits.length === 0)
		failures.push(`origin/${base} has no commits since ${sincePoint.label} — nothing to release.`);

	// 2. Is the work we mean to announce actually on the base?
	if (expect.length > 0) console.log("\nExpected commits:");
	for (const ref of expect) {
		if (!(await gitOk(["rev-parse", "--verify", `${ref}^{commit}`]))) {
			failures.push(`--expect ${ref} is not a commit this checkout knows. Fetch it, or check the SHA.`);
			console.log(`  ✗ ${ref} — unknown to this checkout`);
			continue;
		}
		const contained = await gitOk(["merge-base", "--is-ancestor", ref, baseSha]);
		console.log(`  ${contained ? "✓" : "✗"} ${ref}${contained ? "" : ` — NOT in origin/${base}`}`);
		if (!contained) {
			failures.push(`--expect ${ref} is not an ancestor of origin/${base}. Its pull request is not merged.`);
		}
	}

	// 3. Does every changed package carry Unreleased entries?
	const changedFiles = (await git(["diff", "--name-only", `${sinceRef}..${baseSha}`])).split("\n").filter(Boolean);
	const touched = packagesTouched(changedFiles);
	console.log(`\nPackages changed: ${touched.size === 0 ? "(none)" : ""}`);
	for (const [name, files] of [...touched].sort()) {
		const entries = unreleasedEntries(await changelogAt(baseSha, name));
		console.log(
			`  ${entries.length > 0 ? "✓" : "✗"} ${name} — ${files.length} file(s), ${entries.length} Unreleased entr${entries.length === 1 ? "y" : "ies"}`,
		);
		if (entries.length === 0) {
			failures.push(
				`packages/${name} changed but packages/${name}/CHANGELOG.md has no [Unreleased] entries. ` +
					"Add them, or confirm the change is infrastructure-level per the Changelog rules in CLAUDE.md.",
			);
		}
	}

	// 4. Did anything get documented?
	const docsTouched = changedFiles.filter((file) => DOC_PATHS.some((path) => file.startsWith(path)));
	console.log(`\nDoc files changed: ${docsTouched.length}`);
	if (touched.size > 0 && docsTouched.length === 0) {
		warnings.push(
			`${touched.size} package(s) changed and no README or doc did. Reread them as a new user before releasing: ` +
				"stale documentation is worse than none, because it is trusted.",
		);
	}

	for (const warning of warnings) console.log(`\nWARN  ${warning}`);
	for (const failure of failures) console.log(`\nFAIL  ${failure}`);

	if (failures.length > 0) {
		console.log(`\nNot ready to release: ${failures.length} check(s) failed.`);
		process.exit(1);
	}
	console.log(`\nReady to release from origin/${base}.${warnings.length > 0 ? " Resolve the warnings first." : ""}`);
}

try {
	await main();
} catch (error) {
	// A stack trace here points at this script, never at what is wrong with the
	// release — the message already names the repair.
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
