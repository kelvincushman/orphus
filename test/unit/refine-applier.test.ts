import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	ApplyRefused,
	applyGatedProposals,
	readApplyManifest,
	rollbackApply,
	summarizeApply,
} from "../../packages/subagents/src/refine/applier.ts";
import type { GatedProposal } from "../../packages/subagents/src/refine/gate.ts";
import type { Proposal } from "../../packages/subagents/src/refine/proposal.ts";

const APPLIED_AT = "2026-08-15T00:00:00.000Z";

let repoRoot: string;
let snapshotsDir: string;

beforeEach(() => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "refine-apply-"));
	repoRoot = path.join(base, "repo");
	snapshotsDir = path.join(base, "snapshots");
	fs.mkdirSync(path.join(repoRoot, "skills"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
});

function proposal(overrides: Partial<Proposal> = {}): Proposal {
	return {
		targetPath: "skills/a.md",
		diff: "--- a\n+++ b\n",
		justification: "because",
		evidence: [{ source: "s", locator: "1" }],
		...overrides,
	};
}

function gated(target: Proposal, passed = true): GatedProposal {
	return { proposal: target, verdict: { passed, objections: [] } };
}

function apply(
	entries: GatedProposal[],
	writeContent: (proposal: Proposal, current: string | undefined) => string = () => "NEW CONTENT\n",
) {
	return applyGatedProposals({
		runId: "run1",
		gated: entries,
		repoRoot,
		snapshotsDir,
		appliedAt: APPLIED_AT,
		writeContent,
	});
}

test("rollback restores the tree byte-identically", () => {
	// The acceptance criterion for the phase, stated in the plan and in Rule 2.
	const target = path.join(repoRoot, "skills", "a.md");
	const original = "original content\nwith two lines\n";
	fs.writeFileSync(target, original);

	apply([gated(proposal())]);
	assert.equal(fs.readFileSync(target, "utf8"), "NEW CONTENT\n");

	rollbackApply({ repoRoot, snapshotsDir });
	assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("rolling back a created file removes it", () => {
	// A rollback that restores most of the tree is the kind of nearly-true Rule 2
	// exists to rule out. A file the apply created has no prior content to write
	// back — undoing a creation is a removal.
	const created = path.join(repoRoot, "skills", "brand-new.md");
	assert.equal(fs.existsSync(created), false);

	const manifest = apply([gated(proposal({ targetPath: "skills/brand-new.md" }))]);
	assert.equal(fs.existsSync(created), true);
	assert.equal(manifest.entries[0]?.existed, false);
	assert.equal(manifest.entries[0]?.snapshotFile, undefined);

	rollbackApply({ repoRoot, snapshotsDir });
	assert.equal(fs.existsSync(created), false);
});

test("two proposals touching one file roll back to the true original", () => {
	// Rollback reverses apply order, so the earliest snapshot wins.
	const target = path.join(repoRoot, "skills", "a.md");
	fs.writeFileSync(target, "v0\n");

	let counter = 0;
	apply([gated(proposal()), gated(proposal())], () => {
		counter += 1;
		return `v${counter}\n`;
	});
	assert.equal(fs.readFileSync(target, "utf8"), "v2\n");

	rollbackApply({ repoRoot, snapshotsDir });
	assert.equal(fs.readFileSync(target, "utf8"), "v0\n");
});

test("a proposal that failed the gate is not applied", () => {
	const target = path.join(repoRoot, "skills", "a.md");
	fs.writeFileSync(target, "untouched\n");

	const manifest = apply([gated(proposal(), false)]);

	assert.deepEqual(manifest.entries, []);
	assert.equal(fs.readFileSync(target, "utf8"), "untouched\n");
});

test("the applier refuses paths outside the surface even when the gate passed them", () => {
	// The second of the two independent checks Rule 1 asks for. A verdict of
	// `passed` is not a capability — the applier re-derives the answer.
	for (const hostile of ["../escape.md", "/etc/passwd", "package.json", "packages/roundtable/digest.ts"]) {
		assert.throws(
			() => apply([gated(proposal({ targetPath: hostile }))]),
			ApplyRefused,
			`${hostile} must be refused by the applier`,
		);
	}
	assert.equal(fs.existsSync(path.join(path.dirname(repoRoot), "escape.md")), false);
});

test("the two allowlists are stated independently, so one edit cannot open both doors", () => {
	// If the applier imported the gate's constant, this file and gate.ts would be
	// one check referenced twice. Read both sources and require each to carry its
	// own pattern list.
	const gateSource = fs.readFileSync(
		path.join(import.meta.dirname, "..", "..", "packages", "subagents", "src", "refine", "gate.ts"),
		"utf8",
	);
	const applierSource = fs.readFileSync(
		path.join(import.meta.dirname, "..", "..", "packages", "subagents", "src", "refine", "applier.ts"),
		"utf8",
	);

	assert.match(gateSource, /ALLOWED_SURFACE_PATTERNS: readonly RegExp\[\]/);
	assert.match(applierSource, /APPLIABLE_PATH_PATTERNS: readonly RegExp\[\]/);
	assert.doesNotMatch(applierSource, /import .*ALLOWED_SURFACE_PATTERNS.*from/);
});

test("the snapshot is on disk before the target is touched", () => {
	// An apply interrupted mid-write must leave a recoverable tree. Proven by
	// throwing from writeContent and checking the snapshot survived.
	const target = path.join(repoRoot, "skills", "a.md");
	fs.writeFileSync(target, "original\n");

	assert.throws(
		() =>
			apply([gated(proposal())], () => {
				throw new Error("interrupted mid-apply");
			}),
		/interrupted mid-apply/,
	);

	const snapshots = fs.readdirSync(snapshotsDir).filter((name) => name.endsWith(".snapshot"));
	assert.equal(snapshots.length, 1);
	assert.equal(fs.readFileSync(path.join(snapshotsDir, snapshots[0]!), "utf8"), "original\n");
	assert.equal(fs.readFileSync(target, "utf8"), "original\n");
});

test("an apply that throws partway is still rollbackable", () => {
	// The failure the previous test walked past: if the manifest were written only
	// on success, a first proposal could land, a second throw, and the tree be
	// left changed with no record of it. Rule 2 makes reversibility a property of
	// the system, which means it has to hold on the bad path too.
	const first = path.join(repoRoot, "skills", "a.md");
	const second = path.join(repoRoot, "skills", "b.md");
	fs.writeFileSync(first, "first original\n");
	fs.writeFileSync(second, "second original\n");

	assert.throws(
		() =>
			apply([gated(proposal()), gated(proposal({ targetPath: "skills/b.md" }))], (target) => {
				if (target.targetPath === "skills/b.md") throw new Error("interrupted on the second");
				return "FIRST APPLIED\n";
			}),
		/interrupted on the second/,
	);
	assert.equal(fs.readFileSync(first, "utf8"), "FIRST APPLIED\n");

	const manifest = readApplyManifest(snapshotsDir);
	assert.equal(manifest.entries.length, 2);

	rollbackApply({ repoRoot, snapshotsDir });
	assert.equal(fs.readFileSync(first, "utf8"), "first original\n");
	assert.equal(fs.readFileSync(second, "utf8"), "second original\n");
});

test("the manifest round-trips and names the rollback command", () => {
	fs.writeFileSync(path.join(repoRoot, "skills", "a.md"), "x\n");
	const manifest = apply([gated(proposal())]);

	assert.deepEqual(readApplyManifest(snapshotsDir), manifest);
	const summary = summarizeApply(manifest);
	assert.match(summary, /modified skills\/a\.md/);
	assert.match(summary, /\/refine rollback run1/);
});
