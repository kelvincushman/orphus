/**
 * The evidence a retrospective is allowed to reason from.
 *
 * Phase 3 of the RLM adoption plan turns on one claim: a proposal must cite
 * evidence, and the gate must be able to check the citation. That is only
 * possible if "the evidence" is a definite, addressable set of files rather
 * than whatever the proposing agent happens to remember. This module produces
 * that set.
 *
 * Two properties are load-bearing, and both are tested:
 *
 * 1. **Pointers, not content.** The bundle records paths and sizes. A room
 *    transcript stays on disk exactly as the export design intends — reading it
 *    is the retrospective agent's choice, made against its own budget, not a
 *    cost the bundle imposes on whoever assembles it.
 * 2. **Nothing is silently absent.** Every source the bundle looked for appears
 *    in `present` or in `missing` with a stated reason. A retrospective that
 *    reasons from a partial record while believing it is complete is exactly
 *    the failure `docs/rlm-security-posture.md` is written against, and a
 *    bundle that quietly drops a source is indistinguishable from one where the
 *    source had nothing to say.
 *
 * @see ../../../../docs/rlm-security-posture.md
 * @see ../../../../docs/self-improvement-loop.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where a piece of evidence came from. Kinds exist so the gate can weigh them differently. */
export type EvidenceKind = "artifact" | "session" | "room-transcript" | "context-accounting" | "test-outcome";

/** A file the bundle expected to find. */
export interface EvidenceCandidate {
	kind: EvidenceKind;
	/** Human-facing name — an agent, a room, a suite. Appears in citations. */
	label: string;
	path: string;
	/**
	 * Why this file might legitimately not exist, stated up front by whoever
	 * knew the answer. A caller that knows rooms are memory-only can say so here
	 * instead of leaving the collector to report a bare "not found".
	 */
	absenceHint?: string;
}

export interface EvidenceFound {
	kind: EvidenceKind;
	label: string;
	path: string;
	bytes: number;
}

export interface EvidenceAbsent {
	kind: EvidenceKind;
	label: string;
	path: string;
	reason: string;
}

export interface EvidenceBundle {
	runId: string;
	createdAt: string;
	present: EvidenceFound[];
	missing: EvidenceAbsent[];
}

/** Probes a path. Returns undefined when there is nothing readable there. */
export type EvidenceProbe = (filePath: string) => { bytes: number } | undefined;

const defaultProbe: EvidenceProbe = (filePath) => {
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile() ? { bytes: stat.size } : undefined;
	} catch {
		return undefined;
	}
};

/**
 * A run id is used to build a directory path, so it may not be able to leave
 * that directory.
 *
 * Run ids are generated internally today, which is exactly the argument that
 * gets made right before something starts accepting one from a proposal file or
 * a slash-command argument. `/refine rollback <runId>` will take this from a
 * human's shell. Rejecting a bad id costs one function; discovering later that
 * a path escaped costs considerably more.
 */
export function assertSafeRunId(runId: string): string {
	if (runId.length === 0) throw new Error("runId is empty");
	if (!/^[\w.-]+$/.test(runId)) {
		throw new Error(`runId ${JSON.stringify(runId)} may contain only letters, digits, underscore, dot, and hyphen`);
	}
	if (runId === "." || runId === "..") throw new Error(`runId ${JSON.stringify(runId)} is a directory traversal`);
	return runId;
}

/** Where a run's refine state lives: beside the session, not in a temp dir that a reboot clears. */
export function refineDirFor(sessionFile: string, runId: string): string {
	return path.join(path.dirname(sessionFile), "refine", assertSafeRunId(runId));
}

/**
 * Sort every candidate into found-or-not, with a reason attached to each miss.
 *
 * Deliberately total: `present.length + missing.length === candidates.length`,
 * always. The count is the property that makes the bundle trustworthy — a
 * reader can tell "the room had nothing" apart from "nobody captured the room".
 */
export function collectEvidenceBundle(options: {
	runId: string;
	candidates: readonly EvidenceCandidate[];
	createdAt: string;
	probe?: EvidenceProbe;
}): EvidenceBundle {
	const { runId, candidates, createdAt } = options;
	assertSafeRunId(runId);
	const probe = options.probe ?? defaultProbe;

	const present: EvidenceFound[] = [];
	const missing: EvidenceAbsent[] = [];
	for (const candidate of candidates) {
		const found = probe(candidate.path);
		if (found) {
			present.push({ kind: candidate.kind, label: candidate.label, path: candidate.path, bytes: found.bytes });
			continue;
		}
		missing.push({
			kind: candidate.kind,
			label: candidate.label,
			path: candidate.path,
			reason: candidate.absenceHint ?? "no readable file at this path",
		});
	}
	return { runId, createdAt, present, missing };
}

/**
 * Rooms are the one source that cannot be recovered after the fact.
 *
 * The broker holds rooms in memory with a 500-message cap and persists nothing
 * but a pid file; `roundtable({action:"export"})` is the only way a transcript
 * reaches disk, it is restricted to the writer role, and it writes only under
 * the shared memory `raw/` directory. So a retrospective run after the broker
 * exited finds nothing — and must be told that plainly rather than concluding
 * the discussion was empty.
 */
export const ROOM_TRANSCRIPT_ABSENCE_HINT =
	"no exported transcript — rooms live in the broker's memory (500-message cap) and reach disk only via " +
	'roundtable({action:"export"}), which the writer role must run before the broker exits';

/**
 * The files a completed run is expected to have left behind.
 *
 * Every path here is one this tree already writes. Nothing new is produced at
 * run time: the bundle is assembled on demand, so a feature used occasionally
 * costs nothing on the runs that never ask for it.
 */
export function evidenceCandidatesForRun(options: {
	runId: string;
	artifactsDir: string;
	sessionFile: string;
	/** Agent labels in the run, in task order. Artifact names are `<runId>_<agent>[_<index>]`. */
	agents: readonly { agent: string; index?: number }[];
	/** Room names the run deliberated in, with the export path each would have been written to. */
	rooms?: readonly { room: string; exportPath: string }[];
	/** Suites or evals whose output was captured for this run. */
	testOutcomes?: readonly { label: string; path: string }[];
}): EvidenceCandidate[] {
	const { runId, artifactsDir, sessionFile, agents, rooms = [], testOutcomes = [] } = options;
	assertSafeRunId(runId);

	const candidates: EvidenceCandidate[] = [];
	for (const { agent, index } of agents) {
		const suffix = index !== undefined ? `_${index}` : "";
		const safeAgent = agent.replace(/[^\w.-]/g, "_");
		candidates.push({
			kind: "artifact",
			label: index !== undefined ? `${agent}[${index}]` : agent,
			path: path.join(artifactsDir, `${runId}_${safeAgent}${suffix}_output.md`),
			absenceHint:
				"no output artifact — the run may have had artifacts disabled, or this task never produced output",
		});
	}
	candidates.push({
		kind: "session",
		label: "session transcript",
		path: sessionFile,
		absenceHint: "session file not found — it may have been rotated or the session never wrote one",
	});
	candidates.push({
		kind: "context-accounting",
		label: "context accounting",
		path: sessionFile,
		absenceHint:
			"session file not found, so the context_accounting entry it carries is unreadable — the entry is appended on session dispose",
	});
	for (const { room, exportPath } of rooms) {
		candidates.push({
			kind: "room-transcript",
			label: `#${room}`,
			path: exportPath,
			absenceHint: ROOM_TRANSCRIPT_ABSENCE_HINT,
		});
	}
	for (const { label, path: outcomePath } of testOutcomes) {
		candidates.push({
			kind: "test-outcome",
			label,
			path: outcomePath,
			absenceHint: "no captured output for this suite",
		});
	}
	return candidates;
}

export const EVIDENCE_MANIFEST_FILENAME = "manifest.json";

/**
 * Write the manifest and return its path.
 *
 * The manifest is the whole artifact — there is no second copy of anything it
 * points at. Nothing is copied into the bundle directory, so the bundle cannot
 * drift from the files it describes.
 */
export function writeEvidenceBundle(bundle: EvidenceBundle, evidenceDir: string): string {
	fs.mkdirSync(evidenceDir, { recursive: true });
	const manifestPath = path.join(evidenceDir, EVIDENCE_MANIFEST_FILENAME);
	fs.writeFileSync(manifestPath, `${JSON.stringify(bundle, null, "\t")}\n`, "utf8");
	return manifestPath;
}

/**
 * One line per source, for a human or an agent deciding what to open.
 *
 * Missing sources are listed after present ones rather than omitted, because
 * "the room transcript is gone" is frequently the most useful thing the bundle
 * has to say.
 */
export function summarizeEvidenceBundle(bundle: EvidenceBundle): string {
	const lines = [`Evidence for ${bundle.runId} — ${bundle.present.length} present, ${bundle.missing.length} missing`];
	for (const found of bundle.present) {
		lines.push(`  ✓ [${found.kind}] ${found.label} — ${found.bytes} bytes — ${found.path}`);
	}
	for (const absent of bundle.missing) {
		lines.push(`  ✗ [${absent.kind}] ${absent.label} — ${absent.reason}`);
	}
	return lines.join("\n");
}
