/**
 * What a retrospective is allowed to return, and what happens to it.
 *
 * The shape of this module is a security decision, not an ergonomic one.
 *
 * The plan had the retrospective agent write its proposals to disk itself. A
 * proposer holding `write` can apply its own proposal — it does not need to
 * defeat the gate, it can simply step around it — and Rules 2 and 3 of
 * `docs/rlm-security-posture.md` both rest on the assumption that applying is
 * something only the applier does. So the agent is given a **read-only tool
 * allowlist** and returns proposals as structured output; this module validates
 * them and writes them. The proposer never touches the tree.
 *
 * That is an enforced boundary rather than an instructed one: it holds because
 * the agent has no writing tool, not because its prompt asks it not to.
 *
 * @see ../../../../docs/rlm-security-posture.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeRunId } from "./evidence-bundle.ts";

/**
 * A citation into the evidence bundle.
 *
 * `source` names an evidence label the bundle listed; `locator` is a file line,
 * a room sequence number, or an equivalent address inside it. Both are free
 * text here — the *gate* (WP 3.3) is what checks that the citation resolves and
 * that it supports the change. Validating a citation's shape is not the same as
 * checking it, and this module deliberately claims only the former.
 */
export interface ProposalEvidence {
	source: string;
	locator: string;
}

export interface Proposal {
	/** Repo-relative path the diff applies to. */
	targetPath: string;
	/** Unified diff. Applied by the WP 3.4 applier, never by the proposer. */
	diff: string;
	/** One paragraph: why this change follows from the cited evidence. */
	justification: string;
	/** At least one citation. A proposal that cites nothing is rejected unread. */
	evidence: ProposalEvidence[];
}

export interface ProposalSet {
	runId: string;
	proposals: Proposal[];
}

/**
 * The JSON schema the retrospective agent's structured output is validated
 * against. Structural only — `validateProposalSet` enforces what a schema
 * cannot say, such as "evidence must not be empty *after* trimming".
 */
export const PROPOSAL_SET_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["proposals"],
	properties: {
		proposals: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["targetPath", "diff", "justification", "evidence"],
				properties: {
					targetPath: { type: "string", minLength: 1 },
					diff: { type: "string", minLength: 1 },
					justification: { type: "string", minLength: 1 },
					evidence: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["source", "locator"],
							properties: {
								source: { type: "string", minLength: 1 },
								locator: { type: "string", minLength: 1 },
							},
						},
					},
				},
			},
		},
	},
} as const;

export class ProposalRejected extends Error {
	readonly index: number;
	constructor(index: number, message: string) {
		super(`proposal ${index}: ${message}`);
		this.name = "ProposalRejected";
		this.index = index;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, index: number, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProposalRejected(index, `${field} must be a non-empty string`);
	}
	return value;
}

/**
 * Validate a structured-output value into a `ProposalSet`.
 *
 * Rejects rather than repairs. A proposal this loop cannot read is a proposal
 * nobody should apply, and silently dropping a malformed one would leave the
 * run reporting fewer proposals than the agent believed it made — the same
 * silent-omission failure the evidence bundle refuses.
 */
export function validateProposalSet(runId: string, value: unknown): ProposalSet {
	assertSafeRunId(runId);
	if (!isRecord(value)) throw new Error("structured output is not an object");
	const rawProposals = value.proposals;
	if (!Array.isArray(rawProposals)) throw new Error("structured output has no proposals array");

	const proposals: Proposal[] = rawProposals.map((raw, index) => {
		if (!isRecord(raw)) throw new ProposalRejected(index, "is not an object");
		const targetPath = requireNonEmptyString(raw.targetPath, index, "targetPath");
		const diff = requireNonEmptyString(raw.diff, index, "diff");
		const justification = requireNonEmptyString(raw.justification, index, "justification");

		const rawEvidence = raw.evidence;
		if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
			// Rule 2: "A proposal that cites nothing is rejected without review;
			// 'it seemed better' is not evidence."
			throw new ProposalRejected(index, "cites no evidence");
		}
		const evidence: ProposalEvidence[] = rawEvidence.map((entry, entryIndex) => {
			if (!isRecord(entry)) throw new ProposalRejected(index, `evidence[${entryIndex}] is not an object`);
			return {
				source: requireNonEmptyString(entry.source, index, `evidence[${entryIndex}].source`),
				locator: requireNonEmptyString(entry.locator, index, `evidence[${entryIndex}].locator`),
			};
		});

		return { targetPath, diff, justification, evidence };
	});

	return { runId, proposals };
}

/** Filenames are derived from the index, never from model-supplied text. */
export function proposalFilename(index: number): string {
	return `${String(index).padStart(3, "0")}.json`;
}

/**
 * Write each proposal as its own file under `<refineDir>/proposals/`.
 *
 * One file per proposal so the gate can attach a verdict to each without
 * rewriting a shared document, and so a rejected proposal survives next to its
 * objection — Rule 2 keeps failures as evidence for the next retrospective.
 */
export function writeProposalSet(set: ProposalSet, proposalsDir: string): string[] {
	fs.mkdirSync(proposalsDir, { recursive: true });
	return set.proposals.map((proposal, index) => {
		const filePath = path.join(proposalsDir, proposalFilename(index));
		fs.writeFileSync(filePath, `${JSON.stringify(proposal, null, "\t")}\n`, "utf8");
		return filePath;
	});
}

export function summarizeProposalSet(set: ProposalSet): string {
	if (set.proposals.length === 0) return `No proposals for ${set.runId}.`;
	const lines = [`${set.proposals.length} proposal(s) for ${set.runId}:`];
	for (const [index, proposal] of set.proposals.entries()) {
		const citations = proposal.evidence.map((entry) => `${entry.source}:${entry.locator}`).join(", ");
		lines.push(`  ${index}. ${proposal.targetPath} — cites ${citations}`);
	}
	return lines.join("\n");
}
