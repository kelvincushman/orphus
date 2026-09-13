import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { validateHandoff } from "../../packages/subagents/src/runs/foreground/subagent-executor-input.js";
import { buildHandoffInstruction, HANDOFF_BUDGET_CHARS } from "../../packages/subagents/src/shared/settings.js";

// Budget, plus one bounded marker line, plus the fixed header — the whole cost of a handoff.
const HANDOFF_CEILING_CHARS = HANDOFF_BUDGET_CHARS + 400;

describe("subagent handoff", () => {
	test("a huge value no longer lands whole in the child task", () => {
		const rendered = buildHandoffInstruction({ notes: "x".repeat(100_000) });

		assert.ok(rendered.length < HANDOFF_CEILING_CHARS, `rendered ${rendered.length} chars`);
		// And the child is told how much it is not seeing.
		assert.match(rendered, /\+\d+ chars/);
	});

	test("what does not fit is named, not silently dropped", () => {
		const handoff = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, "v".repeat(500)]));
		const rendered = buildHandoffInstruction(handoff);

		assert.ok(rendered.length < HANDOFF_CEILING_CHARS, `rendered ${rendered.length} chars`);
		assert.match(rendered, /\+\d+ keys not shown: key\d+/);
		// Budget is spent in the parent's order, so the first key is what survives verbatim.
		assert.ok(rendered.includes("- key0: "));
	});

	test("small handoffs pass through verbatim, in the parent's order, under the asserted label", () => {
		const rendered = buildHandoffInstruction({ decision: "use boundedRender", owner: "subagents" });
		const [header, ...body] = rendered.split("\n");

		assert.match(header!, /asserted by the orchestrator, not verified/);
		assert.equal(body.join("\n"), "- decision: use boundedRender\n- owner: subagents");
	});

	test("an empty or missing handoff renders nothing, so the bound costs nothing when unused", () => {
		assert.equal(buildHandoffInstruction(undefined), "");
		assert.equal(buildHandoffInstruction({}), "");
	});

	test("validation rejects anything but string values before a child sees it", () => {
		assert.equal(validateHandoff(undefined), undefined);
		assert.equal(validateHandoff({ a: "b" }), undefined);
		for (const bad of [["a"], "a", 3, null, { a: 1 }, { a: { nested: true } }]) {
			assert.ok(validateHandoff(bad), `${JSON.stringify(bad)} should be rejected`);
		}
	});
});
