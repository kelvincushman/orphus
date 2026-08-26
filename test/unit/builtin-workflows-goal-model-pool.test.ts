import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	goalLeafModelConfig,
	orchestratorModelConfig,
	reviewerModelConfigs,
} from "../../packages/workflows/builtin/goal-models.js";
import type { GoalExecutionTier } from "../../packages/workflows/builtin/goal-plan.js";

const TIERS: readonly GoalExecutionTier[] = ["fast", "standard", "judgment"];

function providerFamily(model: string): string {
	const [provider, name = ""] = model.split("/", 2);
	if (name.startsWith("claude-")) return "anthropic";
	if (name.startsWith("gpt-")) return "openai";
	if (name.startsWith("kimi-")) return "kimi";
	if (name.startsWith("glm-")) return "glm";
	return provider;
}

describe("Goal heterogeneous model pool", () => {
	test("prefers Claude Fable 5 for planning with cross-family fallbacks", () => {
		assert.equal(orchestratorModelConfig.model, "anthropic/claude-fable-5:high");
		assert.equal(orchestratorModelConfig.fallbackModels.includes(orchestratorModelConfig.model), false);
		assert.ok(new Set(orchestratorModelConfig.fallbackModels.map(providerFamily)).size >= 3);
		assert.deepEqual(orchestratorModelConfig.excludedTools, ["ask_user_question"]);
	});

	test("rotates every leaf tier deterministically across at least three model families", () => {
		for (const tier of TIERS) {
			const firstCycle = [0, 1, 2, 3].map((index) => goalLeafModelConfig(tier, index));
			assert.ok(new Set(firstCycle.map((config) => providerFamily(config.model))).size >= 3, tier);
			assert.deepEqual(goalLeafModelConfig(tier, 4), firstCycle[0], tier);
			assert.deepEqual(goalLeafModelConfig(tier, Number.NaN), firstCycle[0], tier);
			for (const config of firstCycle) {
				assert.equal(config.fallbackModels.includes(config.model), false, config.model);
				assert.ok(new Set(config.fallbackModels.map(providerFamily)).size >= 3, config.model);
				assert.deepEqual(config.excludedTools, ["ask_user_question"], config.model);
			}
		}
	});

	test("decorrelates the three final reviewer primaries and preserves their schemas", () => {
		assert.equal(reviewerModelConfigs.length, 3);
		assert.equal(new Set(reviewerModelConfigs.map((config) => providerFamily(config.model))).size, 3);
		for (const config of reviewerModelConfigs) {
			assert.ok(config.schema);
			assert.equal(config.fallbackModels.includes(config.model), false, config.model);
			assert.ok(new Set(config.fallbackModels.map(providerFamily)).size >= 3, config.model);
			assert.deepEqual(config.excludedTools, ["ask_user_question"], config.model);
		}
	});
});
