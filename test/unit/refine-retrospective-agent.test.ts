import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { parseFrontmatter } from "../../packages/subagents/src/agents/frontmatter.ts";
import {
	ProposalRejected,
	proposalFilename,
	summarizeProposalSet,
	validateProposalSet,
	writeProposalSet,
} from "../../packages/subagents/src/refine/proposal.ts";
import { isManagementActionsRestricted } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import { resolveChildModePolicy } from "../../packages/subagents/src/runs/inprocess/child-policy.ts";
import { moduleDir } from "../helpers/runtime.ts";

const AGENT_PATH = path.join(
	moduleDir(import.meta.url),
	"..",
	"..",
	"packages",
	"subagents",
	"agents",
	"retrospective.md",
);

function agentFrontmatter(): Record<string, string> {
	return parseFrontmatter(fs.readFileSync(AGENT_PATH, "utf8")).frontmatter;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refine-proposal-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("the retrospective agent holds no tool that can modify the tree", () => {
	// The rule that makes every other rule credible. A proposer with `write` can
	// apply its own proposal — it does not need to defeat the gate, it can step
	// around it. This is enforced by the allowlist, not by the agent's prompt.
	const tools = (agentFrontmatter().tools ?? "").split(",").map((entry) => entry.trim());

	assert.deepEqual(tools, ["read", "search", "find", "ls"]);
	for (const forbidden of ["write", "edit", "bash", "repl", "subagent"]) {
		assert.ok(!tools.includes(forbidden), `retrospective must not hold the ${forbidden} tool`);
	}
});

test("the retrospective agent cannot delegate", () => {
	// maxSubagentDepth: 1. A retrospective that spawns its own subagents
	// multiplies the context the loop exists to bound.
	assert.equal(agentFrontmatter().maxSubagentDepth, "1");
});

test("no child may create, update, or delete an agent definition", () => {
	// Security posture Rule 3, and the reason a retrospective can only propose.
	// resolveChildModePolicy has no branch that returns "full" — proven here by
	// asking for one with the tool list most likely to widen it.
	const policy = resolveChildModePolicy({
		tools: ["read", "search", "subagent"],
		agent: { tools: ["read", "write", "bash", "subagent"], inheritProjectContext: true, inheritSkills: true },
	});

	assert.equal(policy.managementActions, "restricted");
	assert.equal(isManagementActionsRestricted({ childPolicy: policy }), true);
});

test("a proposal citing no evidence is rejected", () => {
	// Rule 2: "A proposal that cites nothing is rejected without review;
	// 'it seemed better' is not evidence."
	for (const evidence of [[], undefined, null, "file.ts:1"]) {
		assert.throws(
			() =>
				validateProposalSet("run1", {
					proposals: [{ targetPath: "skills/a.md", diff: "@@", justification: "because", evidence }],
				}),
			/cites no evidence/,
		);
	}
});

test("a rejected proposal names which one failed and why", () => {
	// A set is rejected, not silently filtered. Dropping the bad one would leave
	// the run reporting fewer proposals than the agent believed it made.
	const error = (() => {
		try {
			validateProposalSet("run1", {
				proposals: [
					{
						targetPath: "skills/a.md",
						diff: "@@",
						justification: "ok",
						evidence: [{ source: "s", locator: "1" }],
					},
					{ targetPath: "", diff: "@@", justification: "ok", evidence: [{ source: "s", locator: "1" }] },
				],
			});
			return undefined;
		} catch (caught) {
			return caught;
		}
	})();

	assert.ok(error instanceof ProposalRejected);
	assert.equal(error.index, 1);
	assert.match(error.message, /proposal 1: targetPath must be a non-empty string/);
});

test("whitespace is not a citation", () => {
	assert.throws(
		() =>
			validateProposalSet("run1", {
				proposals: [
					{
						targetPath: "skills/a.md",
						diff: "@@",
						justification: "because",
						evidence: [{ source: "  ", locator: "\t" }],
					},
				],
			}),
		/evidence\[0\]\.source must be a non-empty string/,
	);
});

test("a valid set round-trips to one file per proposal", () => {
	const set = validateProposalSet("run1", {
		proposals: [
			{
				targetPath: "skills/a.md",
				diff: "--- a\n+++ b\n",
				justification: "the reviewer repeated itself twice",
				evidence: [{ source: "#design", locator: "seq 41" }],
			},
			{
				targetPath: "packages/subagents/agents/worker.md",
				diff: "--- a\n+++ b\n",
				justification: "the tool failed the same way in both tasks",
				evidence: [{ source: "worker[0]", locator: "line 12" }],
			},
		],
	});
	const written = writeProposalSet(set, path.join(tmpDir, "proposals"));

	assert.deepEqual(
		written.map((filePath) => path.basename(filePath)),
		["000.json", "001.json"],
	);
	assert.deepEqual(JSON.parse(fs.readFileSync(written[1]!, "utf8")), set.proposals[1]);
});

test("proposal filenames come from the index, never from model text", () => {
	// The agent supplies targetPath. If that reached the filename, a proposal
	// could name itself ../../something and land outside the run's directory.
	const set = validateProposalSet("run1", {
		proposals: [
			{
				targetPath: "../../../etc/passwd",
				diff: "@@",
				justification: "hostile",
				evidence: [{ source: "s", locator: "1" }],
			},
		],
	});
	const [written] = writeProposalSet(set, path.join(tmpDir, "proposals"));

	assert.equal(proposalFilename(0), "000.json");
	assert.equal(path.dirname(written!), path.join(tmpDir, "proposals"));
	assert.equal(path.basename(written!), "000.json");
});

test("an empty proposal set is valid and says so", () => {
	// Returning nothing is the correct outcome for a run that went well. If this
	// threw, the agent would be pressured to invent a proposal to succeed.
	const set = validateProposalSet("run1", { proposals: [] });

	assert.deepEqual(set, { runId: "run1", proposals: [] });
	assert.equal(summarizeProposalSet(set), "No proposals for run1.");
});

test("the agent definition states the two rules the runtime cannot enforce", () => {
	// Rules 1 and 3 of the posture are instructions here — the gate re-checks
	// them in WP 3.3. The definition must say so rather than implying the
	// runtime has it covered.
	const body = fs.readFileSync(AGENT_PATH, "utf8");

	assert.match(body, /Never propose an edit to the base system prompt/);
	assert.match(body, /Never propose an edit to your own definition/);
	assert.match(body, /hold only while you follow them/);
});
