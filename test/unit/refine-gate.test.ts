import assert from "node:assert/strict";
import { test } from "vitest";
import type { EvidenceBundle } from "../../packages/subagents/src/refine/evidence-bundle.ts";
import { gateProposal, gateProposals, summarizeGateResults } from "../../packages/subagents/src/refine/gate.ts";
import type { Proposal } from "../../packages/subagents/src/refine/proposal.ts";

const BUNDLE: EvidenceBundle = {
	runId: "run1",
	createdAt: "2026-08-15T00:00:00.000Z",
	present: [
		{ kind: "artifact", label: "reviewer[0]", path: "/a/run1_reviewer_0_output.md", bytes: 120 },
		{ kind: "session", label: "session transcript", path: "/a/session.jsonl", bytes: 900 },
	],
	missing: [{ kind: "room-transcript", label: "#design", path: "/a/raw/design.md", reason: "broker exited" }],
};

function proposal(overrides: Partial<Proposal> = {}): Proposal {
	return {
		targetPath: "skills/discussion-etiquette.md",
		diff: "--- a\n+++ b\n+a new line\n",
		justification: "the reviewer repeated itself",
		evidence: [{ source: "reviewer[0]", locator: "line 12" }],
		...overrides,
	};
}

function rules(target: Proposal): string[] {
	return gateProposal(target, BUNDLE).objections.map((objection) => objection.rule);
}

test("a well-formed proposal inside the surface passes", () => {
	const verdict = gateProposal(proposal(), BUNDLE);

	assert.equal(verdict.passed, true);
	assert.deepEqual(verdict.objections, []);
});

test("the allowed surface is skills, agent definitions, and prompt snippets — and nothing else", () => {
	for (const allowed of [
		"skills/a.md",
		"skills/nested/b.md",
		"packages/roundtable/skills/discussion-etiquette.md",
		"packages/subagents/agents/worker.md",
		".atomic/agents/local.md",
	]) {
		assert.equal(gateProposal(proposal({ targetPath: allowed }), BUNDLE).passed, true, `${allowed} should pass`);
	}

	for (const refused of [
		"packages/roundtable/digest.ts",
		"package.json",
		"docs/architecture.md",
		".github/workflows/ci.yml",
		"skills/a.txt",
		"packages/subagents/agents/worker.ts",
	]) {
		assert.ok(
			rules(proposal({ targetPath: refused })).includes("outside-allowed-surface"),
			`${refused} should be refused`,
		);
	}
});

test("the base system prompt is refused by name, not merely by falling outside the surface", () => {
	// Rule 1 is the single wall. The refusal has to say which rule it is, and it
	// has to survive anyone widening the allowed surface later.
	for (const promptPath of [
		"packages/coding-agent/src/core/system-prompt.ts",
		"packages/coding-agent/src/core/prompt-templates.ts",
		"packages/coding-agent/src/core/agent-session-prompt.ts",
	]) {
		assert.ok(rules(proposal({ targetPath: promptPath })).includes("base-prompt-immutable"), promptPath);
	}
});

test("the loop may not rewrite its own definition", () => {
	const objections = rules(proposal({ targetPath: "packages/subagents/agents/retrospective.md" }));

	assert.ok(objections.includes("self-modification"));
});

test("a path that climbs out is refused as a path, before anything else reads it", () => {
	for (const hostile of ["../../etc/passwd", "skills/../../../etc/passwd", "/etc/passwd"]) {
		assert.ok(rules(proposal({ targetPath: hostile })).includes("outside-allowed-surface"), hostile);
	}
});

test("a proposal may not grant itself new tools", () => {
	// Rule 3, and the reason phases 3 and 4 are sequenced apart: a loop that can
	// rewrite its instructions AND execute code is a different risk class.
	for (const tool of ["repl", "bash", "write", "edit", "subagent"]) {
		const diff = `--- a\n+++ b\n+tools: read, search, ${tool}\n`;
		const objections = rules(proposal({ targetPath: "packages/subagents/agents/worker.md", diff }));
		assert.ok(objections.includes("capability-widening"), `granting ${tool} must be refused`);
	}
});

test("removing a dangerous tool is a narrowing, not a widening", () => {
	// The check reads added lines only. A gate that refused any diff mentioning
	// `repl` would block the very change that takes repl away.
	const diff = "--- a\n+++ b\n-tools: read, write, repl\n+tools: read\n";
	const verdict = gateProposal(proposal({ targetPath: "packages/subagents/agents/worker.md", diff }), BUNDLE);

	assert.equal(verdict.passed, true);
});

test("a citation that resolves to nothing is refused", () => {
	const objections = rules(proposal({ evidence: [{ source: "imaginary-agent", locator: "line 1" }] }));

	assert.ok(objections.includes("citation-does-not-resolve"));
});

test("citing evidence the bundle reported missing is refused, and named as its own failure", () => {
	// The more dangerous shape: it looks like a citation. A room the bundle
	// reported unrecoverable cannot support any claim about what was said in it.
	const verdict = gateProposal(proposal({ evidence: [{ source: "#design", locator: "seq 41" }] }), BUNDLE);

	assert.equal(verdict.passed, false);
	assert.deepEqual(
		verdict.objections.map((objection) => objection.rule),
		["citation-names-missing-evidence"],
	);
	assert.match(verdict.objections[0]!.detail, /reported missing/);
});

test("one proposal wrong three ways is told all three", () => {
	const verdict = gateProposal(
		proposal({
			targetPath: "packages/subagents/agents/retrospective.md",
			diff: "--- a\n+++ b\n+tools: read, repl\n",
			evidence: [{ source: "nope", locator: "1" }],
		}),
		BUNDLE,
	);

	assert.deepEqual(verdict.objections.map((objection) => objection.rule).sort(), [
		"capability-widening",
		"citation-does-not-resolve",
		"self-modification",
	]);
});

test("a refused proposal is kept beside its objection, not dropped", () => {
	// Rule 2: failures are themselves evidence for the next retrospective.
	const gated = gateProposals([proposal(), proposal({ targetPath: "package.json" })], BUNDLE);

	assert.equal(gated.length, 2);
	assert.equal(gated[0]?.verdict.passed, true);
	assert.equal(gated[1]?.verdict.passed, false);
	assert.equal(gated[1]?.proposal.targetPath, "package.json");

	const summary = summarizeGateResults(gated);
	assert.match(summary, /1\/2 proposal\(s\) eligible to apply/);
	assert.match(summary, /\[outside-allowed-surface\]/);
});
