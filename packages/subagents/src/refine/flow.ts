/**
 * The `/refine` pipeline: collect → propose → gate → apply, and rollback.
 *
 * **Stop for approval is structural here, not a setting.** The plan allowed a
 * configurable auto-apply defaulting to off. A default is a value someone can
 * change in a file; this instead makes applying a *separate command a human
 * types*, so there is no configuration that turns the loop autonomous and
 * nothing to get wrong by editing a config. `docs/rlm-security-posture.md`
 * Rule 2 wants the default to be human approval — this is the strongest
 * reading of that, and it costs one extra command.
 *
 * Each stage reads the previous stage's output from disk rather than holding it
 * in memory. That is what makes the stages separately invokable, lets a human
 * read the proposals between gate and apply, and means an interrupted refine
 * resumes rather than restarts.
 *
 * @see ../../../../docs/rlm-security-posture.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	collectEvidenceBundle,
	EVIDENCE_MANIFEST_FILENAME,
	type EvidenceBundle,
	type EvidenceCandidate,
	refineDirFor,
	summarizeEvidenceBundle,
	writeEvidenceBundle,
} from "./evidence-bundle.ts";
import { type GatedProposal, gateProposals, summarizeGateResults } from "./gate.ts";
import { type Proposal, type ProposalSet, validateProposalSet, writeProposalSet } from "./proposal.ts";

export interface RefinePaths {
	root: string;
	evidenceDir: string;
	proposalsDir: string;
	snapshotsDir: string;
	gateResultsPath: string;
}

export function refinePaths(sessionFile: string, runId: string): RefinePaths {
	const root = refineDirFor(sessionFile, runId);
	return {
		root,
		evidenceDir: path.join(root, "evidence"),
		proposalsDir: path.join(root, "proposals"),
		snapshotsDir: path.join(root, "snapshots"),
		gateResultsPath: path.join(root, "gate-results.json"),
	};
}

/** Stage 1 — write the evidence manifest and describe it. */
export function runCollectStage(options: {
	runId: string;
	sessionFile: string;
	candidates: readonly EvidenceCandidate[];
	createdAt: string;
}): { bundle: EvidenceBundle; manifestPath: string; summary: string } {
	const paths = refinePaths(options.sessionFile, options.runId);
	const bundle = collectEvidenceBundle({
		runId: options.runId,
		candidates: options.candidates,
		createdAt: options.createdAt,
	});
	const manifestPath = writeEvidenceBundle(bundle, paths.evidenceDir);
	return { bundle, manifestPath, summary: summarizeEvidenceBundle(bundle) };
}

export function readEvidenceBundle(sessionFile: string, runId: string): EvidenceBundle {
	const paths = refinePaths(sessionFile, runId);
	const manifestPath = path.join(paths.evidenceDir, EVIDENCE_MANIFEST_FILENAME);
	const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null) throw new Error(`${manifestPath} is not an evidence bundle`);
	const bundle = parsed as EvidenceBundle;
	if (!Array.isArray(bundle.present) || !Array.isArray(bundle.missing)) {
		throw new Error(`${manifestPath} is missing its present/missing lists`);
	}
	return bundle;
}

/** Stage 2 — validate the agent's structured output and persist it. */
export function runProposeStage(options: { runId: string; sessionFile: string; structuredOutput: unknown }): {
	set: ProposalSet;
	files: string[];
} {
	const paths = refinePaths(options.sessionFile, options.runId);
	const set = validateProposalSet(options.runId, options.structuredOutput);
	const files = writeProposalSet(set, paths.proposalsDir);
	return { set, files };
}

export function readProposals(sessionFile: string, runId: string): Proposal[] {
	const paths = refinePaths(sessionFile, runId);
	if (!fs.existsSync(paths.proposalsDir)) return [];
	return fs
		.readdirSync(paths.proposalsDir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(paths.proposalsDir, name), "utf8")) as Proposal);
}

/**
 * Stage 3 — gate every proposal and persist the verdicts.
 *
 * Verdicts are written next to the proposals so a refused one keeps its
 * objection, per Rule 2: a rejection is evidence for the next retrospective.
 */
export function runGateStage(options: { runId: string; sessionFile: string }): {
	gated: GatedProposal[];
	summary: string;
	resultsPath: string;
} {
	const paths = refinePaths(options.sessionFile, options.runId);
	const bundle = readEvidenceBundle(options.sessionFile, options.runId);
	const gated = gateProposals(readProposals(options.sessionFile, options.runId), bundle);

	fs.mkdirSync(paths.root, { recursive: true });
	fs.writeFileSync(paths.gateResultsPath, `${JSON.stringify(gated, null, "\t")}\n`, "utf8");
	return { gated, summary: summarizeGateResults(gated), resultsPath: paths.gateResultsPath };
}

export function readGateResults(sessionFile: string, runId: string): GatedProposal[] {
	const paths = refinePaths(sessionFile, runId);
	const parsed: unknown = JSON.parse(fs.readFileSync(paths.gateResultsPath, "utf8"));
	if (!Array.isArray(parsed)) throw new Error(`${paths.gateResultsPath} is not a gate-results array`);
	return parsed as GatedProposal[];
}

/**
 * What a human is asked to approve.
 *
 * Deliberately shows the refused proposals too. An approval prompt that listed
 * only what passed would hide the loop's failures from the one person able to
 * notice that the gate is being talked around.
 */
export function approvalPrompt(gated: readonly GatedProposal[], runId: string): string {
	const eligible = gated.filter((entry) => entry.verdict.passed);
	if (eligible.length === 0) {
		return `${summarizeGateResults(gated)}\n\nNothing is eligible to apply for ${runId}.`;
	}
	return [
		summarizeGateResults(gated),
		"",
		`Nothing has been applied. Review the diffs, then apply with:`,
		`  /refine apply ${runId}`,
		`Undo any apply with:`,
		`  /refine rollback ${runId}`,
	].join("\n");
}
