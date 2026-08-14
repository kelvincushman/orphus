import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	ChainOutputValidationError,
	resolveOutputReferences,
	validateChainOutputBindings,
} from "../../packages/subagents/src/runs/shared/chain-outputs.js";
import type { ChainOutputMap } from "../../packages/subagents/src/shared/types.js";

function outputs(text: string, artifactOutputPath?: string): ChainOutputMap {
	return {
		notes: { text, agent: "researcher", stepIndex: 0, ...(artifactOutputPath ? { artifactOutputPath } : {}) },
	};
}

describe("chain splice", () => {
	test("a huge predecessor no longer lands whole in the next prompt", () => {
		const huge = "x".repeat(100_000);
		const spliced = resolveOutputReferences("Given: {outputs.notes}", outputs(huge, "/artifacts/notes.md"));

		assert.ok(spliced.length < 3_000, `spliced ${spliced.length} chars`);
		// And the reader is told where the rest is.
		assert.ok(spliced.includes("/artifacts/notes.md"));
		assert.match(spliced, /\+\d+ chars/);
	});

	test("{outputs.name.full} is the escape hatch and returns everything", () => {
		const huge = "y".repeat(100_000);
		const spliced = resolveOutputReferences("Given: {outputs.notes.full}", outputs(huge, "/artifacts/notes.md"));

		assert.equal(spliced, `Given: ${huge}`);
	});

	test("small outputs pass through untouched, so the bound costs nothing when unneeded", () => {
		const spliced = resolveOutputReferences("Given: {outputs.notes}", outputs("the answer is 42", "/artifacts/n.md"));
		assert.equal(spliced, "Given: the answer is 42");
	});

	test("an output with nowhere to point splices in full rather than losing content", () => {
		// Artifacts can be off. Bounding without a recovery path would discard
		// text rather than relocate it, so the reference falls back to full.
		const huge = "z".repeat(100_000);
		const spliced = resolveOutputReferences("Given: {outputs.notes}", outputs(huge));
		assert.equal(spliced, `Given: ${huge}`);
	});

	test("validation accepts both forms and rejects anything else", () => {
		const step = (task: string) =>
			[
				{ agent: "a", as: "notes" },
				{ agent: "b", task },
			] as never;

		assert.doesNotThrow(() => validateChainOutputBindings(step("use {outputs.notes}")));
		assert.doesNotThrow(() => validateChainOutputBindings(step("use {outputs.notes.full}")));

		// A suffix that is not `full` is a typo, not a feature — refusing it up
		// front beats silently splicing something the author did not ask for.
		assert.throws(() => validateChainOutputBindings(step("use {outputs.notes.raw}")), ChainOutputValidationError);
		assert.throws(
			() => validateChainOutputBindings(step("use {outputs.notes.full.full}")),
			ChainOutputValidationError,
		);
		assert.throws(() => validateChainOutputBindings(step("use {outputs.1bad}")), ChainOutputValidationError);
	});

	test("validation and resolution agree, so nothing passes the check then fails mid-run", () => {
		// Both go through one parser; this pins that they stay in step.
		for (const reference of ["{outputs.notes}", "{outputs.notes.full}"]) {
			assert.doesNotThrow(() => resolveOutputReferences(reference, outputs("body", "/artifacts/n.md")));
		}
		for (const reference of ["{outputs.notes.raw}", "{outputs.notes.}", "{outputs..full}"]) {
			assert.throws(
				() => resolveOutputReferences(reference, outputs("body", "/artifacts/n.md")),
				ChainOutputValidationError,
				`${reference} should be rejected at splice time too`,
			);
		}
	});

	test("a very long artifact path does not collapse the body to a headline", () => {
		// Artifact paths have no length limit — deep directories and long agent
		// names are ordinary. A fixed pointer allowance would put a cliff here:
		// once path + marker exceeded it, boundedRender would demote the whole
		// 2000-character body to a ~100-character headline while still looking
		// bounded. The allowance is derived from the real path instead.
		const longPath = `/artifacts/${"nested/".repeat(80)}researcher_output.md`;
		assert.ok(longPath.length > 400, `path should exceed any fixed allowance, was ${longPath.length}`);

		const spliced = resolveOutputReferences("Given: {outputs.notes}", outputs("q".repeat(100_000), longPath));

		// The body tier survived: far more than a headline would carry.
		assert.ok(spliced.length > 2_000, `expected the full body tier, got ${spliced.length} chars`);
		assert.ok(spliced.includes(longPath));
		assert.match(spliced, /\+\d+ chars/);
	});

	test("an unknown name still fails loudly rather than splicing nothing", () => {
		assert.throws(
			() => resolveOutputReferences("{outputs.missing}", outputs("body", "/artifacts/n.md")),
			ChainOutputValidationError,
		);
	});
});
