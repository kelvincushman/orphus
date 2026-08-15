/**
 * Applying a gated proposal, and undoing it.
 *
 * Two things here are deliberate and should not be "simplified" away.
 *
 * **The allowlist is checked twice.** `gate.ts` already refused anything
 * outside the allowed surface, and this module refuses it again before writing.
 * That looks redundant and is not: `docs/rlm-security-posture.md` Rule 1 asks
 * for two independent checks precisely because one of them may later be
 * relaxed, reordered, or called by something new. A single check is one edit
 * away from no check.
 *
 * **Every apply snapshots first.** Rule 2 makes reversibility a property of the
 * system rather than a promise: `/refine rollback <runId>` must restore the
 * tree byte-identically, including files the apply *created*, which roll back
 * by being removed rather than rewritten.
 *
 * @see ../../../../docs/rlm-security-posture.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeRunId } from "./evidence-bundle.ts";
import type { GatedProposal } from "./gate.ts";
import type { Proposal } from "./proposal.ts";

/**
 * The applier's own view of what may be written.
 *
 * Independently stated rather than imported from `gate.ts`. Sharing the
 * constant would make the "two independent checks" one check referenced twice —
 * a single edit would still open both doors, which is the failure Rule 1 asks
 * for two checks to prevent.
 */
const APPLIABLE_PATH_PATTERNS: readonly RegExp[] = [
	/^skills\/[\w./-]+\.md$/,
	/^packages\/[\w.-]+\/skills\/[\w./-]+\.md$/,
	/^packages\/subagents\/agents\/[\w.-]+\.md$/,
	/^\.atomic\/agents\/[\w.-]+\.md$/,
];

export class ApplyRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyRefused";
	}
}

/** One file as it stood before the apply. `existed: false` means "remove me to undo". */
export interface SnapshotEntry {
	targetPath: string;
	existed: boolean;
	/** Relative name inside the snapshots directory. Absent when the file did not exist. */
	snapshotFile?: string;
}

export interface ApplyManifest {
	runId: string;
	appliedAt: string;
	entries: SnapshotEntry[];
}

export const APPLY_MANIFEST_FILENAME = "apply-manifest.json";

function assertAppliable(targetPath: string): string {
	const normalized = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
	if (normalized.includes("..") || path.isAbsolute(normalized)) {
		throw new ApplyRefused(`refusing to apply outside the repository: ${targetPath}`);
	}
	if (!APPLIABLE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
		throw new ApplyRefused(`refusing to apply outside the allowed surface: ${targetPath}`);
	}
	return normalized;
}

/** Snapshot names are derived from the index, never from the proposal's own path. */
function snapshotFilename(index: number): string {
	return `${String(index).padStart(3, "0")}.snapshot`;
}

/**
 * Apply the gated proposals that passed, snapshotting each target first.
 *
 * Proposals that failed the gate are skipped rather than silently ignored — the
 * caller gets the manifest of what changed, and the gate results still carry
 * every objection.
 *
 * `writeContent` is how the new file content is produced from the proposal.
 * Kept injectable because applying a unified diff is a separate concern with
 * its own failure modes; this module owns *ordering and reversibility*, not
 * patch semantics.
 */
export function applyGatedProposals(options: {
	runId: string;
	gated: readonly GatedProposal[];
	repoRoot: string;
	snapshotsDir: string;
	appliedAt: string;
	writeContent: (proposal: Proposal, current: string | undefined) => string;
}): ApplyManifest {
	const { runId, gated, repoRoot, snapshotsDir, appliedAt, writeContent } = options;
	assertSafeRunId(runId);

	const eligible = gated.filter((entry) => entry.verdict.passed).map((entry) => entry.proposal);
	fs.mkdirSync(snapshotsDir, { recursive: true });

	const entries: SnapshotEntry[] = [];
	const writeManifest = (): ApplyManifest => {
		const manifest: ApplyManifest = { runId, appliedAt, entries };
		fs.writeFileSync(
			path.join(snapshotsDir, APPLY_MANIFEST_FILENAME),
			`${JSON.stringify(manifest, null, "\t")}\n`,
			"utf8",
		);
		return manifest;
	};

	try {
		for (const [index, proposal] of eligible.entries()) {
			const relative = assertAppliable(proposal.targetPath);
			const absolute = path.join(repoRoot, relative);

			const existed = fs.existsSync(absolute);
			const current = existed ? fs.readFileSync(absolute, "utf8") : undefined;
			const entry: SnapshotEntry = { targetPath: relative, existed };
			if (existed) {
				const snapshotFile = snapshotFilename(index);
				fs.writeFileSync(path.join(snapshotsDir, snapshotFile), current ?? "", "utf8");
				entry.snapshotFile = snapshotFile;
			}
			// Snapshot is on disk before the target is touched. An apply interrupted
			// between these two lines leaves a recoverable tree; the other order does
			// not.
			entries.push(entry);

			const next = writeContent(proposal, current);
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			fs.writeFileSync(absolute, next, "utf8");
		}
	} catch (error) {
		// A partial apply is the case that most needs rolling back, so the manifest
		// has to describe what actually happened rather than only what completed.
		// Without this the first proposal could land, the second throw, and the
		// tree be left changed with no record — reversibility is a property of the
		// system per Rule 2, not a promise that holds when nothing goes wrong.
		writeManifest();
		throw error;
	}

	return writeManifest();
}

export function readApplyManifest(snapshotsDir: string): ApplyManifest {
	const manifestPath = path.join(snapshotsDir, APPLY_MANIFEST_FILENAME);
	const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null) throw new Error(`${manifestPath} is not an apply manifest`);
	const manifest = parsed as ApplyManifest;
	if (!Array.isArray(manifest.entries)) throw new Error(`${manifestPath} has no entries`);
	return manifest;
}

/**
 * Restore every file the manifest recorded.
 *
 * Reverses the apply order so that if two proposals touched one file, the
 * earliest snapshot — the true original — is what survives.
 */
export function rollbackApply(options: { repoRoot: string; snapshotsDir: string }): string[] {
	const { repoRoot, snapshotsDir } = options;
	const manifest = readApplyManifest(snapshotsDir);

	const restored: string[] = [];
	for (const entry of [...manifest.entries].reverse()) {
		const relative = assertAppliable(entry.targetPath);
		const absolute = path.join(repoRoot, relative);
		if (!entry.existed) {
			// The apply created this file. Undoing a creation is a removal; leaving
			// it in place would make rollback restore *most* of the tree, which is
			// the kind of nearly-true that Rule 2 exists to rule out.
			fs.rmSync(absolute, { force: true });
			restored.push(relative);
			continue;
		}
		if (!entry.snapshotFile) throw new Error(`manifest entry for ${entry.targetPath} has no snapshot`);
		const snapshot = fs.readFileSync(path.join(snapshotsDir, entry.snapshotFile), "utf8");
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, snapshot, "utf8");
		restored.push(relative);
	}
	return restored;
}

export function summarizeApply(manifest: ApplyManifest): string {
	if (manifest.entries.length === 0) return `Applied nothing for ${manifest.runId}.`;
	const lines = [`Applied ${manifest.entries.length} change(s) for ${manifest.runId}:`];
	for (const entry of manifest.entries) {
		lines.push(`  ${entry.existed ? "modified" : "created"} ${entry.targetPath}`);
	}
	lines.push(`Roll back with: /refine rollback ${manifest.runId}`);
	return lines.join("\n");
}
