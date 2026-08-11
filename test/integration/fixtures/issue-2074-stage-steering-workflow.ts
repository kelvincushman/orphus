/**
 * Project workflow fixture for the issue #2074 end-to-end scenario.
 *
 * `test/integration/workflow-stage-steering-queue-cli.test.ts` copies this file
 * into a scratch project's `.atomic/workflows/` and lets the real Atomic CLI discover it, so it
 * has to stay self-contained: no relative imports survive the copy.
 *
 * One stage, one prompt. The stand-in model endpoint
 * (`issue-2074-model-server.ts`) opens the turn and never closes it, so the
 * stage is streaming for the whole scenario. That is the state issue #2074 is
 * about: a message typed into an attached stage chat is queued rather than
 * delivered, and the queue has to survive the user leaving the node.
 */

import { workflow } from "@orphus/workflows";

export default workflow({
	name: "issue-2074-stage-steering",
	description: "Single stage held mid-turn so its queued user messages can be steered and re-read (issue #2074).",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("steerable").prompt("hold this turn open");
		return {};
	},
});
