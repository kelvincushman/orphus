/**
 * `/refine` — the retrospective loop's entry point.
 *
 * The command is thin on purpose. Every stage it calls is a tested function in
 * this directory; the handler's only job is to route a subcommand and report.
 *
 * The subcommands are separate rather than one end-to-end run because
 * **applying must be something a human does**. There is no `--yes`, and no
 * config key that makes the loop autonomous — see `flow.ts`.
 *
 *   /refine <runId>            collect evidence and brief the retrospective agent
 *   /refine gate <runId>       gate the proposals it returned
 *   /refine apply <runId>      apply the proposals that passed
 *   /refine rollback <runId>   restore the tree from the apply snapshots
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { APPLY_MANIFEST_FILENAME, applyGatedProposals, rollbackApply, summarizeApply } from "./applier.ts";
import { assertSafeRunId, EVIDENCE_MANIFEST_FILENAME } from "./evidence-bundle.ts";
import { approvalPrompt, readGateResults, refinePaths, runGateStage } from "./flow.ts";
import type { Proposal } from "./proposal.ts";

export interface RefineCommandDeps {
	/** Absolute path of the session whose runs are being refined. */
	sessionFile: string;
	repoRoot: string;
	now: () => string;
	/** Produce the new file content for a proposal. Injected — patch semantics are not this module's concern. */
	writeContent: (proposal: Proposal, current: string | undefined) => string;
}

export const REFINE_USAGE = [
	"usage:",
	"  /refine <runId>            collect evidence and brief the retrospective agent",
	"  /refine gate <runId>       gate the proposals it returned",
	"  /refine apply <runId>      apply the proposals that passed the gate",
	"  /refine rollback <runId>   restore the tree from the apply snapshots",
].join("\n");

/**
 * The brief handed to the retrospective agent.
 *
 * It receives the manifest *path*, not the manifest contents — the agent reads
 * what it decides it needs. Handing it the whole bundle would reintroduce the
 * cost the bundle exists to avoid.
 */
export function retrospectiveBrief(runId: string, manifestPath: string): string {
	return [
		`Run a retrospective on run ${runId}.`,
		"",
		`The evidence manifest is at:`,
		`  ${manifestPath}`,
		"",
		"Read the manifest first. It lists every source with a path, and every source that is",
		"missing with the reason it is missing. A source reported missing is unrecoverable —",
		"do not infer its contents, and do not read absence as agreement.",
		"",
		"Return proposals as structured output. Every proposal must cite at least one source",
		"from the manifest. Returning zero proposals is a valid outcome.",
	].join("\n");
}

export function handleRefineCommand(args: string, deps: RefineCommandDeps): string {
	const trimmed = args.trim();
	if (trimmed === "") return REFINE_USAGE;

	const [first, ...rest] = trimmed.split(/\s+/u);
	const subcommands = new Set(["gate", "apply", "rollback"]);
	const subcommand = subcommands.has(first ?? "") ? (first as string) : "collect";
	const runId = subcommand === "collect" ? first : rest[0];

	if (!runId) return REFINE_USAGE;
	try {
		assertSafeRunId(runId);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const paths = refinePaths(deps.sessionFile, runId);

	switch (subcommand) {
		case "gate": {
			// An unknown run is an ordinary question with an ordinary answer, not an
			// ENOENT to put in front of whoever typed the command. `rollback` already
			// answered it this way; these two leaked the raw error.
			if (!fs.existsSync(path.join(paths.evidenceDir, EVIDENCE_MANIFEST_FILENAME))) {
				return `No evidence collected for ${runId} yet. Run \`/refine ${runId}\` first.`;
			}
			return runGateStage({ runId, sessionFile: deps.sessionFile }).summary;
		}
		case "apply": {
			if (!fs.existsSync(paths.gateResultsPath)) {
				return `No gate results for ${runId}. Run \`/refine gate ${runId}\` first.`;
			}
			const gated = readGateResults(deps.sessionFile, runId);
			const manifest = applyGatedProposals({
				runId,
				gated,
				repoRoot: deps.repoRoot,
				snapshotsDir: paths.snapshotsDir,
				appliedAt: deps.now(),
				writeContent: deps.writeContent,
			});
			return summarizeApply(manifest);
		}
		case "rollback": {
			// A run that was never applied has no manifest. That is an ordinary
			// answer to an ordinary question, not an exception to surface at
			// someone typing a command.
			if (!fs.existsSync(path.join(paths.snapshotsDir, APPLY_MANIFEST_FILENAME))) {
				return `Nothing to roll back for ${runId} — no apply has been recorded.`;
			}
			const restored = rollbackApply({ repoRoot: deps.repoRoot, snapshotsDir: paths.snapshotsDir });
			if (restored.length === 0) return `Nothing to roll back for ${runId}.`;
			return [`Restored ${restored.length} file(s) for ${runId}:`, ...restored.map((file) => `  ${file}`)].join(
				"\n",
			);
		}
		default: {
			// `collect` is handled by the caller, which owns evidence discovery and
			// the subagent invocation. Returning the approval prompt for an already
			// gated run makes a bare `/refine <runId>` useful as a status check.
			try {
				return approvalPrompt(readGateResults(deps.sessionFile, runId), runId);
			} catch {
				return `No gate results yet for ${runId}. Collect evidence and run the retrospective first.`;
			}
		}
	}
}
