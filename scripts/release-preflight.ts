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
 *   - every package changed since that tag records that change in its changelog
 *
 * It also warns — without failing — when packages changed but no doc or README
 * did. Whether a doc is now misleading is a judgement call a script cannot
 * make; naming the gap is the most it can honestly do.
 *
 * Usage:
 *   bun run scripts/release-preflight.ts [--base <ref>] [--since <tag>] [--expect <ref>]...
 *
 * `--expect` takes the commit on the base, not the pull request head. This
 * repository squash-merges, so a merged PR's head is never an ancestor of
 * `main` and passing it fails a release that is genuinely ready. Take the SHA
 * from the base's own log.
 *
 * Examples:
 *   bun run scripts/release-preflight.ts
 *   bun run scripts/release-preflight.ts --base main --expect 4071c215
 */

import { resolve } from "node:path";
import { $ } from "bun";
import { canonicalReleaseBaseRef, parseReleaseBaseTrailers, type ReleaseBaseMetadata } from "./release-base.js";

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

/** Every `v*` tag origin has, newest version first. */
async function originReleaseTags(): Promise<string[]> {
	const remote = await git(["ls-remote", "--tags", "--refs", "origin", "v*"]);
	const onOrigin = new Set(
		remote
			.split("\n")
			.map((line) => line.split("refs/tags/")[1])
			.filter((name): name is string => name !== undefined && name.length > 0),
	);
	// git decides the version ordering; keep only the tags origin also has.
	const ordered = (await git(["tag", "--list", "v*", "--sort=-v:refname"])).split("\n").filter(Boolean);
	return ordered.filter((tag) => onOrigin.has(tag));
}

/**
 * The newest release origin has that was cut from this base, and the commit it
 * was cut from.
 *
 * Two things disqualify a tag. A local tag is not evidence of a release:
 * `cut-release.ts` tags this checkout and publishes only under `--push`, so a
 * dry run leaves a higher version behind that origin never saw. And a tag cut
 * from a different base measures a different line of history — a release may be
 * cut from any protected base, and each tag records which one it came from in
 * `Release-base-ref`. Ignoring that would reject a valid release on one base
 * because a newer one exists on another.
 *
 * What comes back is the base commit, not the tag: a release tag points at a
 * detached `Release <version>` commit that is never merged back, so it is not
 * an ancestor of the base and `git describe` cannot see it from there.
 */
async function resolveSincePoint(base: string): Promise<{ ref: string; label: string }> {
	await fetchOrFail(["--tags", "--quiet", "origin"], "tags");
	const baseRef = canonicalReleaseBaseRef(base);
	let untrailered: string | undefined;

	for (const tag of await originReleaseTags()) {
		let trailers: ReleaseBaseMetadata;
		try {
			trailers = parseReleaseBaseTrailers(await git(["log", "-1", "--format=%B", tag]));
		} catch {
			// A tag made by hand names no base, so it cannot be attributed to one.
			// Keep the newest as a last resort rather than claiming it is this base's.
			untrailered ??= tag;
			continue;
		}
		if (trailers.baseRef !== baseRef) continue;
		return { ref: trailers.baseSha, label: `${tag} (cut from ${baseRef} at ${trailers.baseSha.slice(0, 9)})` };
	}

	if (untrailered)
		return { ref: untrailered, label: `${untrailered} (no release-base trailers; using the tag itself)` };
	throw new Error(
		[
			`Origin has no v* tag cut from ${baseRef}, so there is no range to check.`,
			"A shallow clone carries no tags locally: run `git fetch --unshallow --tags origin`.",
			"If this really is the first release from this base, pass the starting point with --since <ref>.",
		].join("\n"),
	);
}

/**
 * Entry lines a changelog has gained since the last release: everything above
 * the topmost section that was already there when that release was cut.
 *
 * Asking only for `[Unreleased]` entries was wrong at the one moment this gate
 * exists for. Cutting a release moves those entries under a dated version
 * heading — the state the release itself requires — and the check then called
 * the package undocumented and failed, with the changelog in exactly the shape
 * it was supposed to be in. Both shapes say the same thing: an entry above the
 * last released section has not shipped yet.
 *
 * `[Unreleased]` is never the boundary even though both files carry it; the
 * boundary is the first *version* heading they share. A changelog that did not
 * exist at the last release, or has no released section yet, is pending whole.
 */
function entriesNotYetReleased(current: string, atLastRelease: string): string[] {
	const headings = current.match(/^## \[[^\]]+\][^\n]*$/gmu) ?? [];
	const released = headings.find(
		(heading) => !heading.startsWith("## [Unreleased]") && atLastRelease.includes(heading),
	);
	const pending = released ? current.slice(0, current.indexOf(released)) : current;
	return pending
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
	const sincePoint = since ? { ref: since, label: since } : await resolveSincePoint(base);
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
			failures.push(
				`--expect ${ref} is not an ancestor of origin/${base}. Either its pull request is not merged, ` +
					"or it is the pull request head and the merge squashed it — pass the commit from the base's own log.",
			);
		}
	}

	// 3. Does every changed package record that change in its changelog?
	const changedFiles = (await git(["diff", "--name-only", `${sinceRef}..${baseSha}`])).split("\n").filter(Boolean);
	const touched = packagesTouched(changedFiles);
	console.log(`\nPackages changed: ${touched.size === 0 ? "(none)" : ""}`);
	for (const [name, files] of [...touched].sort()) {
		const entries = entriesNotYetReleased(await changelogAt(baseSha, name), await changelogAt(sinceRef, name));
		console.log(
			`  ${entries.length > 0 ? "✓" : "✗"} ${name} — ${files.length} file(s), ${entries.length} unreleased entr${entries.length === 1 ? "y" : "ies"}`,
		);
		if (entries.length === 0) {
			failures.push(
				`packages/${name} changed but packages/${name}/CHANGELOG.md records nothing since ${sincePoint.label}. ` +
					"Add entries under [Unreleased], or confirm the change is infrastructure-level per the Changelog rules in CLAUDE.md.",
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
