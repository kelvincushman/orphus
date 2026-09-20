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
 * It also reports every surface a release must reach — changelogs, README,
 * documentation, the website and the announcement — and warns, without failing,
 * on the ones this repository can see that nothing touched. Whether a doc is now
 * misleading is a judgement call a script cannot make; naming the gap is the
 * most it can honestly do. The website and the announcement live outside this
 * repository and are listed rather than checked, because a surface nothing
 * lists is the one that gets forgotten.
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

/**
 * Every surface a release has to reach, and whether this script can see it.
 *
 * The old check was a single count of doc files: 17 could change without the
 * README among them and it stayed silent, because "a doc changed" and "the
 * right doc changed" looked identical. Each surface is now reported on its own.
 *
 * `checkable: false` marks the ones that live outside this repository — the
 * website is a separate repo and the announcement is prose. Naming them here
 * anyway is the point: an unchecked surface that nothing lists is the one that
 * gets forgotten, which is how orphus.dev announced "v2.1 coming soon" for a
 * month after v2.1.2 shipped.
 */
const SURFACES: readonly {
	readonly name: string;
	readonly paths?: readonly string[];
	readonly checkable: boolean;
	readonly note: string;
}[] = [
	{ name: "README.md", paths: ["README.md"], checkable: true, note: "what Orphus is and how it is run" },
	{
		name: "documentation",
		paths: ["docs/", "packages/coding-agent/docs/"],
		checkable: true,
		note: "docs/ and the user-facing coding-agent docs",
	},
	{ name: "website", checkable: false, note: "kelvincushman/orphus-site — sync from main AFTER the tag" },
	{ name: "announcement", checkable: false, note: "GitHub release body, then the LinkedIn and X posts" },
];

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
 *
 * `.quiet()` captures git's output rather than streaming it; `--quiet` is
 * deliberately NOT passed on, because it suppresses the very line that says why
 * a fetch failed. A checkout holding a tag that diverges from origin's fails
 * with `! [rejected] … (would clobber existing tag)` and, under `--quiet`,
 * nothing else — so this reported an unreachable origin for a purely local
 * conflict, and sent the reader looking at the network.
 */
async function fetchOrFail(args: string[], what: string): Promise<void> {
	const result = await $`git -C ${ROOT} fetch ${args}`.nothrow().quiet();
	if (result.exitCode === 0) return;
	const said = result.stderr.toString().trim();
	throw new Error(
		[
			`Could not fetch ${what} from origin, so every ref below would be whatever this checkout already had.`,
			said.includes("would clobber existing tag")
				? "A local tag diverges from origin's. Delete it locally and re-run; nothing on origin changes. git said:"
				: "Check the branch name and that origin is reachable. git said:",
			said || "(no output)",
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
	await fetchOrFail(["--tags", "origin"], "tags");
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
	await fetchOrFail(["origin", `refs/heads/${base}:refs/remotes/origin/${base}`], `origin/${base}`);
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

	// 4. Did the release reach every surface?
	const docsTouched = changedFiles.filter((file) => DOC_PATHS.some((path) => file.startsWith(path)));
	console.log("\nRelease surfaces:");
	console.log(`  ✓ changelogs — ${touched.size} package(s), checked above`);
	for (const surface of SURFACES) {
		if (!surface.checkable) {
			console.log(`  → ${surface.name} — ${surface.note}`);
			continue;
		}
		const hit = changedFiles.filter((file) => (surface.paths ?? []).some((path) => file.startsWith(path)));
		console.log(`  ${hit.length > 0 ? "✓" : "✗"} ${surface.name} — ${hit.length} file(s); ${surface.note}`);
		if (touched.size > 0 && hit.length === 0) {
			warnings.push(
				`${touched.size} package(s) changed and ${surface.name} did not (${surface.note}). ` +
					"Reread it as a new user: the test is not whether you added docs, it is whether anyone following " +
					"the current ones would now be misled.",
			);
		}
	}
	if (touched.size > 0 && docsTouched.length === 0) {
		warnings.push("Nothing under README.md, docs/ or packages/coding-agent/docs/ changed at all.");
	}
	// Deliberately NOT a warning. The → surfaces are unchecked on every release,
	// so warning about them every time would train the reader to skim past the
	// warnings that do mean something. Listing them is the reminder; the release
	// skill owns them as steps.

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
