/**
 * cost-estimator — per-model token pricing for cost attribution.
 *
 * Prices are in USD per 1 million tokens. The table is intentionally
 * separate from the tool code so updating a price doesn't require a deploy
 * of any tool logic — only this file changes.
 *
 * These figures are approximate and for instrumentation/budgeting purposes
 * only. Verify against the provider's billing page before using for invoicing.
 */

interface TokenPricing {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
}

/**
 * Model pricing table keyed by model name prefix (longest match wins).
 * Prices sourced from public provider pages as of 2025-08.
 */
const PRICING_TABLE: ReadonlyArray<[prefix: string, pricing: TokenPricing]> = [
  ["claude-opus-4", { inputPer1M: 15.0, outputPer1M: 75.0 }],
  ["claude-sonnet-4", { inputPer1M: 3.0, outputPer1M: 15.0 }],
  ["claude-haiku-4", { inputPer1M: 0.8, outputPer1M: 4.0 }],
  ["claude-3-5-sonnet", { inputPer1M: 3.0, outputPer1M: 15.0 }],
  ["claude-3-5-haiku", { inputPer1M: 0.8, outputPer1M: 4.0 }],
  ["claude-3-opus", { inputPer1M: 15.0, outputPer1M: 75.0 }],
  ["claude-3-haiku", { inputPer1M: 0.25, outputPer1M: 1.25 }],
  ["gpt-4o-mini", { inputPer1M: 0.15, outputPer1M: 0.6 }],
  ["gpt-4o", { inputPer1M: 2.5, outputPer1M: 10.0 }],
  ["gpt-4-turbo", { inputPer1M: 10.0, outputPer1M: 30.0 }],
  ["gpt-3.5-turbo", { inputPer1M: 0.5, outputPer1M: 1.5 }],
];

/** Fallback when no prefix matches — assumes a mid-range model. */
const DEFAULT_PRICING: TokenPricing = { inputPer1M: 3.0, outputPer1M: 15.0 };

/**
 * Resolve the pricing entry for a given model name.
 * Uses longest-prefix matching so "claude-sonnet-4-6" matches "claude-sonnet-4".
 */
export function resolvePricing(model: string): TokenPricing {
  const lower = model.toLowerCase();
  let best: TokenPricing | undefined;
  let bestLen = 0;

  for (const [prefix, pricing] of PRICING_TABLE) {
    if (lower.startsWith(prefix) && prefix.length > bestLen) {
      best = pricing;
      bestLen = prefix.length;
    }
  }

  return best ?? DEFAULT_PRICING;
}

/**
 * estimateCostUsd — calculate the estimated USD cost of a single LLM call.
 *
 * @param model           - Model name as reported by the provider.
 * @param promptTokens    - Number of input tokens in the request.
 * @param completionTokens - Number of output tokens in the response.
 * @returns Estimated cost in USD, rounded to 8 decimal places.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const { inputPer1M, outputPer1M } = resolvePricing(model);
  const cost = (promptTokens * inputPer1M + completionTokens * outputPer1M) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
