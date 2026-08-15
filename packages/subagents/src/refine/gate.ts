/**
 * The gate a proposal must pass before anything may apply it.
 *
 * This is the Factorio countermeasure named in `docs/rlm-security-posture.md`:
 * an agent told not to cheat refined its way into cheating anyway, not by
 * defying the instruction but by iterating until it found a path the
 * instruction did not cover. The lesson written down there is specific:
 *
 * > A gate is an evidence-based check, not an instruction. It asks "does the
 * > cited evidence support this change, and does this change stay inside the
 * > allowed surface?" It never asks the proposer whether the proposal is
 * > acceptable, and it never trusts a self-report.
 *
 * So every check here is deterministic code over the proposal's own text. None
 * of it asks a model anything. The adversarial-verification workflow runs
 * *after* this and can only reject further — it is a second opinion on
 * proposals that already passed, never a way to overturn a refusal.
 *
 * What this gate does **not** claim: that a passing proposal is a good idea.
 * It claims the proposal targets something it is allowed to target, does not
 * widen the loop's own capabilities, and cites evidence that actually exists.
 * Whether the evidence *supports* the change is the reviewer's judgement, and
 * that is why a human approval step remains the default in WP 3.4.
 *
 * @see ../../../../docs/rlm-security-posture.md
 */

import type { EvidenceBundle } from "./evidence-bundle.ts";
import type { Proposal } from "./proposal.ts";

/** Which rule refused, so a rejection can be argued with rather than merely obeyed. */
export type GateRule =
	| "outside-allowed-surface"
	| "base-prompt-immutable"
	| "self-modification"
	| "capability-widening"
	| "citation-does-not-resolve"
	| "citation-names-missing-evidence";

export interface GateObjection {
	rule: GateRule;
	detail: string;
}

export interface GateVerdict {
	passed: boolean;
	objections: GateObjection[];
}

/**
 * The only paths a proposal may target.
 *
 * An allowlist, not a denylist. A denylist of forbidden paths is exactly the
 * shape of instruction the Factorio incident defeated — it protects what
 * somebody thought to name, and a proposal only has to find a path nobody
 * named. This enumerates what is permitted and refuses everything else,
 * including files that do not exist yet.
 */
const ALLOWED_SURFACE_PATTERNS: readonly RegExp[] = [
	/^skills\/[\w./-]+\.md$/,
	/^packages\/[\w.-]+\/skills\/[\w./-]+\.md$/,
	/^packages\/subagents\/agents\/[\w.-]+\.md$/,
	/^\.atomic\/agents\/[\w.-]+\.md$/,
];

/**
 * The loop's own definition. Rule 1's second wall — a proposal may not edit the
 * thing that defines what the proposer is.
 */
const SELF_DEFINITION_PATH = "packages/subagents/agents/retrospective.md";

/**
 * Tools a proposal may never add to any agent definition.
 *
 * Rule 3: the refine loop cannot widen its own capabilities, and specifically
 * may not grant `repl`. Phase 3 and Phase 4 are individually bounded but
 * jointly dangerous — a loop that rewrites its own instructions *and* executes
 * arbitrary code with the user's permissions is a different risk class.
 */
const FORBIDDEN_TOOL_GRANTS: readonly string[] = ["repl", "bash", "write", "edit", "subagent"];

/**
 * Paths that are the base system prompt or compile into it.
 *
 * Kept as a prefix list rather than exact files because the base prompt is
 * assembled from several modules; a proposal targeting any of them is
 * targeting the prompt. This is belt-and-braces — none of these are inside the
 * allowed surface either, so the surface check refuses them first. The rule
 * exists separately so the refusal *says* base-prompt rather than the vaguer
 * outside-the-surface, and so it survives anyone widening the surface later.
 */
const BASE_PROMPT_PREFIXES: readonly string[] = [
	"packages/coding-agent/src/core/system-prompt",
	"packages/coding-agent/src/core/prompt-templates",
	"packages/coding-agent/src/core/agent-session-prompt",
];

/** Normalize for comparison without letting the result escape upward. */
function normalizePath(targetPath: string): string {
	return targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Lines a unified diff *adds*. Only additions can grant a capability; a diff
 * that removes `repl` from a tools line is a narrowing and must not be refused
 * for mentioning the word.
 */
function addedLines(diff: string): string[] {
	return diff
		.split(/\r?\n/)
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1));
}

function checkSurface(targetPath: string, objections: GateObjection[]): void {
	const normalized = normalizePath(targetPath);

	if (BASE_PROMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
		objections.push({
			rule: "base-prompt-immutable",
			detail: `${targetPath} is part of the base system prompt, which no self-modification may touch`,
		});
	}
	if (normalized === SELF_DEFINITION_PATH) {
		objections.push({
			rule: "self-modification",
			detail: `${targetPath} is the retrospective agent's own definition; a loop may not rewrite the terms it is judged by`,
		});
	}
	// A traversal never matches the anchored patterns below, but say so precisely
	// rather than letting it fall through to the generic surface refusal.
	if (normalized.includes("..") || normalized.startsWith("/")) {
		objections.push({
			rule: "outside-allowed-surface",
			detail: `${targetPath} is not a repo-relative path inside the allowed surface`,
		});
		return;
	}
	if (!ALLOWED_SURFACE_PATTERNS.some((pattern) => pattern.test(normalized))) {
		objections.push({
			rule: "outside-allowed-surface",
			detail: `${targetPath} is not a skill, agent definition, or prompt snippet — the allowed surface for self-modification`,
		});
	}
}

function checkCapabilityWidening(proposal: Proposal, objections: GateObjection[]): void {
	for (const line of addedLines(proposal.diff)) {
		const match = /^\s*tools:\s*(.+)$/.exec(line);
		if (!match) continue;
		const granted = match[1]!.split(",").map((entry) => entry.trim().toLowerCase());
		for (const forbidden of FORBIDDEN_TOOL_GRANTS) {
			if (granted.includes(forbidden)) {
				objections.push({
					rule: "capability-widening",
					detail: `the diff grants the '${forbidden}' tool; a proposal may not widen the loop's capabilities`,
				});
			}
		}
	}
}

function checkCitations(proposal: Proposal, bundle: EvidenceBundle, objections: GateObjection[]): void {
	const present = new Set(bundle.present.map((entry) => entry.label));
	const missing = new Set(bundle.missing.map((entry) => entry.label));

	for (const citation of proposal.evidence) {
		if (present.has(citation.source)) continue;
		if (missing.has(citation.source)) {
			// Citing a source the bundle reported absent is citing nothing — and it
			// is the more dangerous shape, because it looks like a citation.
			objections.push({
				rule: "citation-names-missing-evidence",
				detail: `cites '${citation.source}', which the evidence bundle reported missing`,
			});
			continue;
		}
		objections.push({
			rule: "citation-does-not-resolve",
			detail: `cites '${citation.source}', which is not a source in the evidence bundle`,
		});
	}
}

/**
 * Judge one proposal. Collects every objection rather than stopping at the
 * first, so a proposal that is wrong in three ways is told all three — one
 * round trip instead of three.
 */
export function gateProposal(proposal: Proposal, bundle: EvidenceBundle): GateVerdict {
	const objections: GateObjection[] = [];
	checkSurface(proposal.targetPath, objections);
	checkCapabilityWidening(proposal, objections);
	checkCitations(proposal, bundle, objections);
	return { passed: objections.length === 0, objections };
}

export interface GatedProposal {
	proposal: Proposal;
	verdict: GateVerdict;
}

/**
 * Judge a set. Every proposal gets a verdict — refusals are kept beside their
 * objections rather than dropped, because Rule 2 makes a rejected proposal
 * evidence for the next retrospective.
 */
export function gateProposals(proposals: readonly Proposal[], bundle: EvidenceBundle): GatedProposal[] {
	return proposals.map((proposal) => ({ proposal, verdict: gateProposal(proposal, bundle) }));
}

export function summarizeGateResults(gated: readonly GatedProposal[]): string {
	const passed = gated.filter((entry) => entry.verdict.passed).length;
	const lines = [`Gate: ${passed}/${gated.length} proposal(s) eligible to apply`];
	for (const [index, entry] of gated.entries()) {
		if (entry.verdict.passed) {
			lines.push(`  ✓ ${index}. ${entry.proposal.targetPath}`);
			continue;
		}
		lines.push(`  ✗ ${index}. ${entry.proposal.targetPath}`);
		for (const objection of entry.verdict.objections) {
			lines.push(`      [${objection.rule}] ${objection.detail}`);
		}
	}
	return lines.join("\n");
}
