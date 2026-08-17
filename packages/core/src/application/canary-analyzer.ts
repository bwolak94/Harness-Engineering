import type { CanaryRunMetrics } from "../ports/canary-store.port.js";

// ---------------------------------------------------------------------------
// CanaryDivergence — measured difference between canary and baseline
// ---------------------------------------------------------------------------

export interface CanaryDivergence {
  /** Absolute difference in step count (canary − baseline). */
  stepCountDelta: number;
  /** Percentage change in token usage ((canary − baseline) / baseline × 100). */
  tokenDeltaPct: number;
  /** Percentage change in cost ((canary − baseline) / baseline × 100). */
  costDeltaPct: number;
  /** Percentage change in wall-clock duration ((canary − baseline) / baseline × 100). */
  durationDeltaPct: number;
}

export interface CanaryThresholds {
  /** Maximum acceptable percentage increase in cost. Default: 20. */
  maxCostDeltaPct: number;
  /** Maximum acceptable percentage increase in token usage. Default: 20. */
  maxTokenDeltaPct: number;
  /** Maximum acceptable percentage increase in duration. Default: 50. */
  maxDurationDeltaPct: number;
}

export const DEFAULT_CANARY_THRESHOLDS: CanaryThresholds = {
  maxCostDeltaPct: 20,
  maxTokenDeltaPct: 20,
  maxDurationDeltaPct: 50,
};

export interface CanaryAnalysis {
  divergence: CanaryDivergence;
  /**
   * True when any threshold is breached. A regression means the canary is
   * materially worse than the baseline on cost, tokens, or duration.
   */
  regression: boolean;
  /** Human-readable explanation when regression is true. */
  regressionReason: string | undefined;
}

// ---------------------------------------------------------------------------
// analyzeCanaryRun — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Compare canary metrics to baseline and determine whether a regression occurred.
 *
 * Safe division: if the baseline value is 0 (e.g. 0 tokens), the delta is 0
 * to avoid division-by-zero NaN/Infinity in the output.
 */
export function analyzeCanaryRun(
  baseline: CanaryRunMetrics,
  canary: CanaryRunMetrics,
  thresholds: CanaryThresholds = DEFAULT_CANARY_THRESHOLDS,
): CanaryAnalysis {
  const safePct = (canaryVal: number, baselineVal: number): number => {
    if (baselineVal === 0) return 0;
    return ((canaryVal - baselineVal) / baselineVal) * 100;
  };

  const divergence: CanaryDivergence = {
    stepCountDelta: canary.stepCount - baseline.stepCount,
    tokenDeltaPct: safePct(canary.tokensUsed, baseline.tokensUsed),
    costDeltaPct: safePct(canary.costUsd, baseline.costUsd),
    durationDeltaPct: safePct(canary.durationMs, baseline.durationMs),
  };

  const reasons: string[] = [];

  if (divergence.costDeltaPct > thresholds.maxCostDeltaPct) {
    reasons.push(
      `cost increased by ${divergence.costDeltaPct.toFixed(1)}% (threshold: ${thresholds.maxCostDeltaPct}%)`,
    );
  }

  if (divergence.tokenDeltaPct > thresholds.maxTokenDeltaPct) {
    reasons.push(
      `token usage increased by ${divergence.tokenDeltaPct.toFixed(1)}% (threshold: ${thresholds.maxTokenDeltaPct}%)`,
    );
  }

  if (divergence.durationDeltaPct > thresholds.maxDurationDeltaPct) {
    reasons.push(
      `duration increased by ${divergence.durationDeltaPct.toFixed(1)}% (threshold: ${thresholds.maxDurationDeltaPct}%)`,
    );
  }

  const regression = reasons.length > 0;
  const regressionReason = regression ? reasons.join("; ") : undefined;

  return { divergence, regression, regressionReason };
}
