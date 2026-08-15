import { z } from "zod";

import type { ModelUsage } from "./model-adapter.js";

/**
 * Official USD prices per 1M tokens, captured from
 * https://api-docs.deepseek.com/quick_start/pricing on 2026-08-15.
 * A model absent from this table is deliberately unpriced and must not be
 * committed as a known-cost paid call.
 */
export const DEEPSEEK_PRICING_VERSION = "deepseek-pricing:2026-08-15" as const;

export interface DeepSeekPrice {
  readonly cachedInputUsdPerMillion: number;
  readonly uncachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export const DEEPSEEK_PRICES: Readonly<Record<string, DeepSeekPrice>> = Object.freeze({
  "deepseek-v4-flash": Object.freeze({
    cachedInputUsdPerMillion: 0.0028,
    uncachedInputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
  }),
  "deepseek-v4-pro": Object.freeze({
    cachedInputUsdPerMillion: 0.003625,
    uncachedInputUsdPerMillion: 0.435,
    outputUsdPerMillion: 0.87,
  }),
});

export interface PricedModelUsage {
  readonly pricingVersion: typeof DEEPSEEK_PRICING_VERSION;
  readonly costUsd: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
}

export function priceDeepSeekUsage(model: string, usage: ModelUsage): PricedModelUsage | null {
  const price = DEEPSEEK_PRICES[model];
  if (!price) return null;
  const parsed = z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
  }).parse(usage);
  if (parsed.cachedTokens > parsed.inputTokens) return null;
  const uncachedInputTokens = parsed.inputTokens - parsed.cachedTokens;
  const costUsd = (
    parsed.cachedTokens * price.cachedInputUsdPerMillion +
    uncachedInputTokens * price.uncachedInputUsdPerMillion +
    parsed.outputTokens * price.outputUsdPerMillion
  ) / 1_000_000;
  return {
    pricingVersion: DEEPSEEK_PRICING_VERSION,
    costUsd,
    cachedInputTokens: parsed.cachedTokens,
    uncachedInputTokens,
  };
}

export function estimateDeepSeekCostUsd(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number | null {
  const price = DEEPSEEK_PRICES[model];
  if (!price || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0) {
    return null;
  }
  return (
    inputTokens * price.uncachedInputUsdPerMillion +
    maxOutputTokens * price.outputUsdPerMillion
  ) / 1_000_000;
}
