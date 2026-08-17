import { describe, expect, it } from "vitest";
import type { CanaryRunMetrics } from "../../ports/canary-store.port.js";
import { DEFAULT_CANARY_THRESHOLDS, analyzeCanaryRun } from "../canary-analyzer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseMetrics: CanaryRunMetrics = {
  stepCount: 3,
  tokensUsed: 1000,
  costUsd: 0.05,
  durationMs: 2000,
  partial: false,
};

function canaryWith(overrides: Partial<CanaryRunMetrics>): CanaryRunMetrics {
  return { ...baseMetrics, ...overrides };
}

// ---------------------------------------------------------------------------
// analyzeCanaryRun — divergence calculation
// ---------------------------------------------------------------------------

describe("analyzeCanaryRun — divergence calculation", () => {
  it("returns zero deltas when canary matches baseline exactly", () => {
    const analysis = analyzeCanaryRun(baseMetrics, baseMetrics);
    expect(analysis.divergence.stepCountDelta).toBe(0);
    expect(analysis.divergence.tokenDeltaPct).toBe(0);
    expect(analysis.divergence.costDeltaPct).toBe(0);
    expect(analysis.divergence.durationDeltaPct).toBe(0);
    expect(analysis.regression).toBe(false);
    expect(analysis.regressionReason).toBeUndefined();
  });

  it("calculates positive step delta when canary uses more steps", () => {
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ stepCount: 5 }));
    expect(analysis.divergence.stepCountDelta).toBe(2);
  });

  it("calculates negative step delta when canary uses fewer steps", () => {
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ stepCount: 1 }));
    expect(analysis.divergence.stepCountDelta).toBe(-2);
  });

  it("calculates correct token delta percentage", () => {
    // canary uses 1200 tokens vs baseline 1000 → +20%
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ tokensUsed: 1200 }));
    expect(analysis.divergence.tokenDeltaPct).toBeCloseTo(20, 1);
  });

  it("calculates correct cost delta percentage", () => {
    // canary costs $0.06 vs $0.05 → +20%
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ costUsd: 0.06 }));
    expect(analysis.divergence.costDeltaPct).toBeCloseTo(20, 1);
  });

  it("calculates correct duration delta percentage", () => {
    // canary takes 3000ms vs 2000ms → +50%
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ durationMs: 3000 }));
    expect(analysis.divergence.durationDeltaPct).toBeCloseTo(50, 1);
  });

  it("returns 0 for percentage deltas when baseline is 0 (safe division)", () => {
    const zeroBase: CanaryRunMetrics = { ...baseMetrics, tokensUsed: 0, costUsd: 0 };
    const analysis = analyzeCanaryRun(zeroBase, canaryWith({ tokensUsed: 100, costUsd: 0.1 }));
    expect(analysis.divergence.tokenDeltaPct).toBe(0);
    expect(analysis.divergence.costDeltaPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeCanaryRun — regression detection
// ---------------------------------------------------------------------------

describe("analyzeCanaryRun — regression detection", () => {
  it("no regression when all deltas are within thresholds", () => {
    // +10% on all dimensions — within default 20/20/50 thresholds
    const analysis = analyzeCanaryRun(
      baseMetrics,
      canaryWith({
        tokensUsed: 1100,
        costUsd: 0.055,
        durationMs: 2200,
      }),
    );
    expect(analysis.regression).toBe(false);
    expect(analysis.regressionReason).toBeUndefined();
  });

  it("regression when cost exceeds threshold", () => {
    // +25% cost, exceeds default 20% threshold
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ costUsd: 0.0625 }));
    expect(analysis.regression).toBe(true);
    expect(analysis.regressionReason).toContain("cost");
  });

  it("regression when token usage exceeds threshold", () => {
    // +25% tokens, exceeds default 20% threshold
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ tokensUsed: 1250 }));
    expect(analysis.regression).toBe(true);
    expect(analysis.regressionReason).toContain("token usage");
  });

  it("regression when duration exceeds threshold", () => {
    // +60% duration, exceeds default 50% threshold
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ durationMs: 3200 }));
    expect(analysis.regression).toBe(true);
    expect(analysis.regressionReason).toContain("duration");
  });

  it("regression reason lists all breached dimensions", () => {
    // Both cost (+25%) and tokens (+25%) exceed thresholds
    const analysis = analyzeCanaryRun(
      baseMetrics,
      canaryWith({ costUsd: 0.0625, tokensUsed: 1250 }),
    );
    expect(analysis.regression).toBe(true);
    expect(analysis.regressionReason).toContain("cost");
    expect(analysis.regressionReason).toContain("token usage");
  });

  it("no regression when canary is cheaper and faster than baseline", () => {
    const analysis = analyzeCanaryRun(
      baseMetrics,
      canaryWith({ tokensUsed: 800, costUsd: 0.04, durationMs: 1500 }),
    );
    expect(analysis.regression).toBe(false);
  });

  it("respects custom thresholds", () => {
    // Only 5% cost increase, but custom threshold is 0%
    const analysis = analyzeCanaryRun(baseMetrics, canaryWith({ costUsd: 0.0525 }), {
      maxCostDeltaPct: 0,
      maxTokenDeltaPct: 20,
      maxDurationDeltaPct: 50,
    });
    expect(analysis.regression).toBe(true);
  });

  it("no regression with very lenient custom thresholds", () => {
    // +30% everywhere, but thresholds set to 50%
    const analysis = analyzeCanaryRun(
      baseMetrics,
      canaryWith({ tokensUsed: 1300, costUsd: 0.065, durationMs: 2600 }),
      { maxCostDeltaPct: 50, maxTokenDeltaPct: 50, maxDurationDeltaPct: 50 },
    );
    expect(analysis.regression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CANARY_THRESHOLDS
// ---------------------------------------------------------------------------

describe("DEFAULT_CANARY_THRESHOLDS", () => {
  it("has expected default values", () => {
    expect(DEFAULT_CANARY_THRESHOLDS.maxCostDeltaPct).toBe(20);
    expect(DEFAULT_CANARY_THRESHOLDS.maxTokenDeltaPct).toBe(20);
    expect(DEFAULT_CANARY_THRESHOLDS.maxDurationDeltaPct).toBe(50);
  });
});
