import { reviewDecisionSchema } from "./goal-schemas.js";
import type { GoalExecutionTier } from "./goal-plan.js";

const GOAL_EXCLUDED_TOOLS = ["ask_user_question"] as const;

const FABLE_PRIMARY = "anthropic/claude-fable-5:high";
const OPUS_PRIMARY = "anthropic/claude-opus-5:high";
const GPT_SOL_PRIMARY = "openai-codex/gpt-5.6-sol:xhigh";
const KIMI_PRIMARY = "kimi-coding/k3:max";
const GLM_PRIMARY = "zai/glm-5.2:xhigh";
const GROK_PRIMARY = "xai/grok-4.5:high";

const JUDGMENT_FALLBACKS = [
  "github-copilot/claude-fable-5:high",
  FABLE_PRIMARY,
  OPUS_PRIMARY,
  "github-copilot/claude-opus-5:high",
  GPT_SOL_PRIMARY,
  "github-copilot/gpt-5.6-sol:xhigh",
  "openai/gpt-5.6-sol:xhigh",
  KIMI_PRIMARY,
  "moonshotai/kimi-k3:max",
  "moonshotai-cn/kimi-k3:max",
  "openai-codex/gpt-5.5:xhigh",
  "github-copilot/gpt-5.5:xhigh",
  "openai/gpt-5.5:xhigh",
  "anthropic/claude-opus-4-8:high",
  "github-copilot/claude-opus-4.8:high",
  GROK_PRIMARY,
  GLM_PRIMARY,
  "zai-coding-cn/glm-5.2:xhigh",
  "openrouter/anthropic/claude-fable-5:high",
  "openrouter/anthropic/claude-opus-5:high",
  "openrouter/openai/gpt-5.6-sol:xhigh",
  "openrouter/moonshotai/kimi-k3:max",
  "openrouter/sakana/fugu-ultra:high",
  "openrouter/openai/gpt-5.5:xhigh",
  "openrouter/anthropic/claude-opus-4-8:high",
  "openrouter/x-ai/grok-4.5",
  "openrouter/z-ai/glm-5.2:xhigh",
] as const;

const STANDARD_FALLBACKS = [
  "github-copilot/gpt-5.6-sol:high",
  FABLE_PRIMARY,
  "github-copilot/claude-fable-5:high",
  OPUS_PRIMARY,
  "github-copilot/claude-opus-5:high",
  KIMI_PRIMARY,
  "moonshotai/kimi-k3:max",
  "openai-codex/gpt-5.5:high",
  "github-copilot/gpt-5.5:high",
  "openai/gpt-5.5:high",
  GLM_PRIMARY,
  "zai-coding-cn/glm-5.2:xhigh",
  GROK_PRIMARY,
  "openrouter/openai/gpt-5.6-sol:xhigh",
  "openrouter/anthropic/claude-fable-5:high",
  "openrouter/anthropic/claude-opus-5:high",
  "openrouter/moonshotai/kimi-k3:max",
  "openrouter/openai/gpt-5.5:xhigh",
  "openrouter/z-ai/glm-5.2:xhigh",
  "openrouter/x-ai/grok-4.5",
] as const;

const FAST_FALLBACKS = [
  "github-copilot/gpt-5.5:medium",
  "openai/gpt-5.5:medium",
  "anthropic/claude-fable-5:low",
  "github-copilot/claude-fable-5:low",
  "kimi-coding/k3:max",
  "moonshotai/kimi-k3:max",
  "zai/glm-5.2:high",
  "zai-coding-cn/glm-5.2:high",
  "openrouter/openai/gpt-5.5:medium",
  "openrouter/anthropic/claude-fable-5:low",
  "openrouter/moonshotai/kimi-k3:max",
  "openrouter/z-ai/glm-5.2:high",
] as const;

function withoutPrimary(primary: string, fallbacks: readonly string[]): readonly string[] {
  return fallbacks.filter((model) => model !== primary);
}

function modelConfig(primary: string, fallbacks: readonly string[]) {
  return {
    model: primary,
    fallbackModels: withoutPrimary(primary, fallbacks),
    excludedTools: [...GOAL_EXCLUDED_TOOLS],
  };
}

const LEAF_POOLS: Record<GoalExecutionTier, readonly ReturnType<typeof modelConfig>[]> = {
  judgment: [
    modelConfig(FABLE_PRIMARY, JUDGMENT_FALLBACKS),
    modelConfig(GPT_SOL_PRIMARY, JUDGMENT_FALLBACKS),
    modelConfig(KIMI_PRIMARY, JUDGMENT_FALLBACKS),
    modelConfig(GLM_PRIMARY, JUDGMENT_FALLBACKS),
  ],
  standard: [
    modelConfig(GPT_SOL_PRIMARY, STANDARD_FALLBACKS),
    modelConfig(FABLE_PRIMARY, STANDARD_FALLBACKS),
    modelConfig(KIMI_PRIMARY, STANDARD_FALLBACKS),
    modelConfig(GLM_PRIMARY, STANDARD_FALLBACKS),
  ],
  fast: [
    modelConfig("openai-codex/gpt-5.5:medium", FAST_FALLBACKS),
    modelConfig("anthropic/claude-fable-5:low", FAST_FALLBACKS),
    modelConfig("kimi-coding/k3:max", FAST_FALLBACKS),
    modelConfig("zai/glm-5.2:high", FAST_FALLBACKS),
  ],
};

export const orchestratorModelConfig = modelConfig(FABLE_PRIMARY, JUDGMENT_FALLBACKS);

export function goalLeafModelConfig(tier: GoalExecutionTier, index: number) {
  const pool = LEAF_POOLS[tier];
  const normalizedIndex = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return pool[normalizedIndex % pool.length];
}

export const reviewerModelConfigs = [
  { ...modelConfig(OPUS_PRIMARY, JUDGMENT_FALLBACKS), schema: reviewDecisionSchema },
  { ...modelConfig(GPT_SOL_PRIMARY, JUDGMENT_FALLBACKS), schema: reviewDecisionSchema },
  { ...modelConfig(KIMI_PRIMARY, JUDGMENT_FALLBACKS), schema: reviewDecisionSchema },
] as const;

export const reviewerModelConfig = reviewerModelConfigs[0];
