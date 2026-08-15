import { describe, expect, it } from "vitest";

import { DEEPSEEK_PRICING_VERSION, estimateDeepSeekCostUsd, priceDeepSeekUsage } from "../src/model/deepseek-pricing.js";

describe("DeepSeek local pricing", () => {
  it("prices cached, uncached and output tokens independently", () => {
    const priced = priceDeepSeekUsage("deepseek-v4-flash", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 250_000,
      totalTokens: 2_000_000,
      costUsd: null,
      durationMs: 100,
      providerUsage: {},
    });

    expect(priced).toEqual({
      pricingVersion: DEEPSEEK_PRICING_VERSION,
      cachedInputTokens: 250_000,
      uncachedInputTokens: 750_000,
      costUsd: 0.3857,
    });
  });

  it("fails closed for an unknown model or contradictory cache usage", () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 2,
      totalTokens: 2,
      costUsd: null,
      durationMs: 1,
      providerUsage: {},
    };
    expect(priceDeepSeekUsage("deepseek-v4-flash", usage)).toBeNull();
    expect(priceDeepSeekUsage("future-model", { ...usage, cachedTokens: 0 })).toBeNull();
    expect(estimateDeepSeekCostUsd("future-model", 100, 100)).toBeNull();
    expect(estimateDeepSeekCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000)).toBe(0.42);
  });
});
