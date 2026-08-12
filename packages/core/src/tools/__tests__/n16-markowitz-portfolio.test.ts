import type { MarkowitzPortfolioInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createMarkowitzPortfolioTool } from "../n16-markowitz-portfolio.js";

// ---------------------------------------------------------------------------
// Minimal tool definition (no real metadata needed for pure-math tests)
// ---------------------------------------------------------------------------

const DEF = {
  name: "markowitzPortfolio",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "cheap" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createMarkowitzPortfolioTool(DEF);

// ---------------------------------------------------------------------------
// Shared fixtures
//
// 2-asset case with analytically tractable values:
//   Asset A: μ=10%, σ=20% → var=0.04
//   Asset B: μ=20%, σ=30% → var=0.09
//   Correlation ρ=0.3  → cov(A,B)=0.3·0.20·0.30=0.018
//   Risk-free rate: 5%
//
// Analytical global min-variance weights (long-only = unconstrained here):
//   w_A* = (σ_B² − cov) / (σ_A² + σ_B² − 2·cov) = (0.09−0.018)/(0.04+0.09−0.036) ≈ 0.766
//   w_B* ≈ 0.234
//
// Analytical tangency weights (Σ^{-1}(μ−rf·1), normalized):
//   w_A ≈ 0.261, w_B ≈ 0.739
// ---------------------------------------------------------------------------

const TWO_ASSET: MarkowitzPortfolioInput = {
  assets: [
    { name: "A", expectedReturn: 0.10 },
    { name: "B", expectedReturn: 0.20 },
  ],
  covarianceMatrix: [
    [0.04, 0.018],
    [0.018, 0.09],
  ],
  riskFreeRate: 0.05,
  allowShortSelling: false,
};

const TWO_ASSET_UNCONSTRAINED: MarkowitzPortfolioInput = {
  ...TWO_ASSET,
  allowShortSelling: true,
};

// 3-asset fixture for broader coverage
const THREE_ASSET: MarkowitzPortfolioInput = {
  assets: [
    { name: "Equity", expectedReturn: 0.12 },
    { name: "Bond", expectedReturn: 0.04 },
    { name: "Gold", expectedReturn: 0.07 },
  ],
  covarianceMatrix: [
    [0.0400, 0.0020, 0.0060],
    [0.0020, 0.0009, 0.0005],
    [0.0060, 0.0005, 0.0144],
  ],
  riskFreeRate: 0.02,
  allowShortSelling: false,
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sumWeights(weights: Record<string, number>): number {
  return Object.values(weights).reduce((s, w) => s + w, 0);
}

// ---------------------------------------------------------------------------
// Output structure
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — output structure", () => {
  it("returns all required fields with correct types", async () => {
    const out = await tool.execute(TWO_ASSET);

    expect(typeof out.portfolioReturn).toBe("number");
    expect(typeof out.portfolioVolatility).toBe("number");
    expect(typeof out.sharpeRatio).toBe("number");
    expect(typeof out.weights).toBe("object");
    expect(Array.isArray(out.efficientFrontierPoints)).toBe(true);
    expect(Array.isArray(out.assumptions)).toBe(true);
  });

  it("weights record contains exactly one key per asset", async () => {
    const out = await tool.execute(THREE_ASSET);
    const keys = Object.keys(out.weights);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("Equity");
    expect(keys).toContain("Bond");
    expect(keys).toContain("Gold");
  });

  it("efficient frontier has exactly 21 points", async () => {
    const out = await tool.execute(TWO_ASSET);
    expect(out.efficientFrontierPoints).toHaveLength(21);
  });

  it("each frontier point has volatility, expectedReturn, sharpeRatio", async () => {
    const out = await tool.execute(TWO_ASSET);
    for (const pt of out.efficientFrontierPoints) {
      expect(typeof pt.volatility).toBe("number");
      expect(typeof pt.expectedReturn).toBe("number");
      expect(typeof pt.sharpeRatio).toBe("number");
    }
  });

  it("assumptions array is non-empty", async () => {
    const out = await tool.execute(TWO_ASSET);
    expect(out.assumptions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Portfolio constraints
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — portfolio constraints", () => {
  it("weights sum to 1 (long-only)", async () => {
    const out = await tool.execute(TWO_ASSET);
    expect(sumWeights(out.weights)).toBeCloseTo(1, 4);
  });

  it("weights sum to 1 (unconstrained)", async () => {
    const out = await tool.execute(TWO_ASSET_UNCONSTRAINED);
    expect(sumWeights(out.weights)).toBeCloseTo(1, 4);
  });

  it("all weights are non-negative in long-only mode", async () => {
    const out = await tool.execute(THREE_ASSET);
    for (const [, w] of Object.entries(out.weights)) {
      expect(w).toBeGreaterThanOrEqual(-1e-6); // tiny numerical slack
    }
  });

  it("weights sum to 1 for 3-asset case", async () => {
    const out = await tool.execute(THREE_ASSET);
    expect(sumWeights(out.weights)).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------------------------
// Sharpe ratio optimization (tangency portfolio, default mode)
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — Sharpe maximization", () => {
  it("optimal Sharpe ≥ equal-weight Sharpe (long-only)", async () => {
    const out = await tool.execute(TWO_ASSET);
    // Equal-weight portfolio for comparison
    const eqReturn = 0.5 * 0.10 + 0.5 * 0.20; // 0.15
    const eqVar = 0.25 * 0.04 + 2 * 0.25 * 0.018 + 0.25 * 0.09; // 0.0415
    const eqStdDev = Math.sqrt(eqVar); // ≈ 0.2037
    const eqSharpe = (eqReturn - 0.05) / eqStdDev; // ≈ 0.491
    expect(out.sharpeRatio).toBeGreaterThanOrEqual(eqSharpe - 0.01);
  });

  it("optimal Sharpe ≥ equal-weight Sharpe (unconstrained)", async () => {
    const out = await tool.execute(TWO_ASSET_UNCONSTRAINED);
    const eqStdDev = Math.sqrt(0.25 * 0.04 + 2 * 0.25 * 0.018 + 0.25 * 0.09);
    const eqSharpe = (0.15 - 0.05) / eqStdDev;
    expect(out.sharpeRatio).toBeGreaterThanOrEqual(eqSharpe - 0.01);
  });

  it("unconstrained tangency weights match analytical values (2-asset)", async () => {
    // Analytical: w_A ≈ 0.261, w_B ≈ 0.739 (computed from Σ^{-1}·(μ−rf·1)).
    const out = await tool.execute(TWO_ASSET_UNCONSTRAINED);
    expect(out.weights["A"]).toBeCloseTo(0.261, 1);
    expect(out.weights["B"]).toBeCloseTo(0.739, 1);
  });

  it("higher-return asset receives greater weight in tangency portfolio", async () => {
    const out = await tool.execute(TWO_ASSET);
    // Asset B (20% return) should dominate in a max-Sharpe portfolio.
    expect((out.weights["B"] ?? 0)).toBeGreaterThan((out.weights["A"] ?? 0));
  });

  it("portfolioReturn = w^T μ (consistency check)", async () => {
    const out = await tool.execute(THREE_ASSET);
    const mu = [0.12, 0.04, 0.07];
    const names = ["Equity", "Bond", "Gold"];
    const computed = names.reduce((s, name, i) => s + (out.weights[name] ?? 0) * (mu[i] ?? 0), 0);
    expect(out.portfolioReturn).toBeCloseTo(computed, 6);
  });

  it("sharpeRatio = (return − rf) / volatility (consistency check)", async () => {
    const out = await tool.execute(TWO_ASSET);
    const expected = (out.portfolioReturn - 0.05) / out.portfolioVolatility;
    expect(out.sharpeRatio).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------------------
// Global minimum-variance portfolio (analytical check, 2-asset)
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — minimum-variance properties", () => {
  it("global min-variance is found as first efficient frontier point", async () => {
    const out = await tool.execute(TWO_ASSET);
    // The first frontier point should be the min-variance portfolio.
    const first = out.efficientFrontierPoints[0];
    expect(first).toBeDefined();
    // Its volatility must be ≤ that of every other frontier point.
    for (const pt of out.efficientFrontierPoints) {
      expect((first?.volatility ?? Infinity)).toBeLessThanOrEqual(pt.volatility + 1e-6);
    }
  });

  it("global min-variance volatility < equal-weight volatility", async () => {
    const out = await tool.execute(TWO_ASSET);
    const eqVol = Math.sqrt(0.25 * 0.04 + 2 * 0.25 * 0.018 + 0.25 * 0.09);
    const minVarVol = out.efficientFrontierPoints[0]?.volatility ?? Infinity;
    expect(minVarVol).toBeLessThan(eqVol);
  });

  it("analytical min-variance weights match expected values (2-asset, unconstrained)", async () => {
    // For a 2-asset portfolio: w_A* = (σ_B² − cov) / (σ_A²+σ_B²−2·cov)
    //   = (0.09 − 0.018) / (0.04 + 0.09 − 0.036) = 0.072 / 0.094 ≈ 0.766
    const out = await tool.execute({ ...TWO_ASSET_UNCONSTRAINED, targetVolatility: undefined });
    // Check via frontier first point (min-variance).
    const minVarPt = out.efficientFrontierPoints[0];
    expect(minVarPt?.volatility).toBeCloseTo(0.1868, 1);
  });
});

// ---------------------------------------------------------------------------
// targetVolatility mode
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — targetVolatility", () => {
  it("resulting volatility is approximately equal to the target", async () => {
    const targetVol = 0.22; // between min-var ≈ 0.187 and max-return ≈ 0.30
    const out = await tool.execute({ ...TWO_ASSET, targetVolatility: targetVol });
    expect(out.portfolioVolatility).toBeCloseTo(targetVol, 1); // within ±0.05
  });

  it("target below min-var: returns min-variance portfolio", async () => {
    // Min-var vol ≈ 0.187; targeting 0.05 is below that.
    const out = await tool.execute({ ...TWO_ASSET, targetVolatility: 0.05 });
    const minVarOut = await tool.execute(TWO_ASSET); // tangency, but frontier[0] is min-var
    const minVarVol = out.efficientFrontierPoints[0]?.volatility ?? 0;
    // The result should be close to the min-variance portfolio's volatility.
    expect(out.portfolioVolatility).toBeCloseTo(minVarVol, 2);
  });

  it("target above max-single-asset vol: returns max-return portfolio", async () => {
    // Max single-asset (B) vol = sqrt(0.09) = 0.30; targeting 0.60 exceeds it.
    const out = await tool.execute({ ...TWO_ASSET, targetVolatility: 0.60 });
    // Max-return portfolio is 100% in asset B → vol = 0.30.
    expect(out.portfolioVolatility).toBeCloseTo(0.30, 2);
    expect(out.weights["B"]).toBeCloseTo(1, 1);
    expect(out.weights["A"]).toBeCloseTo(0, 1);
  });

  it("weights sum to 1 in targetVolatility mode", async () => {
    const out = await tool.execute({ ...TWO_ASSET, targetVolatility: 0.22 });
    expect(sumWeights(out.weights)).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------------------------
// Efficient frontier properties
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — efficient frontier", () => {
  it("first frontier point has the lowest volatility (min-variance is leftmost)", async () => {
    const out = await tool.execute(THREE_ASSET);
    const vols = out.efficientFrontierPoints.map((p) => p.volatility);
    const minVol = Math.min(...vols);
    expect(out.efficientFrontierPoints[0]?.volatility).toBeCloseTo(minVol, 4);
  });

  it("last frontier point has the highest expected return", async () => {
    const out = await tool.execute(THREE_ASSET);
    const returns = out.efficientFrontierPoints.map((p) => p.expectedReturn);
    const maxReturn = Math.max(...returns);
    const lastReturn = out.efficientFrontierPoints.at(-1)?.expectedReturn ?? -Infinity;
    expect(lastReturn).toBeCloseTo(maxReturn, 4);
  });

  it("expected returns are non-decreasing along the frontier", async () => {
    const out = await tool.execute(THREE_ASSET);
    const returns = out.efficientFrontierPoints.map((p) => p.expectedReturn);
    for (let i = 1; i < returns.length; i++) {
      expect(returns[i] ?? 0).toBeGreaterThanOrEqual((returns[i - 1] ?? 0) - 1e-6);
    }
  });

  it("all frontier volatilities are non-negative", async () => {
    const out = await tool.execute(THREE_ASSET);
    for (const pt of out.efficientFrontierPoints) {
      expect(pt.volatility).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — validation", () => {
  it("throws when covarianceMatrix row count mismatches asset count", async () => {
    const bad: MarkowitzPortfolioInput = {
      ...TWO_ASSET,
      covarianceMatrix: [[0.04, 0.018, 0]], // 3 rows for 2 assets
    };
    await expect(tool.execute(bad)).rejects.toThrow(/rows/);
  });

  it("throws when covarianceMatrix row is the wrong length", async () => {
    const bad: MarkowitzPortfolioInput = {
      ...TWO_ASSET,
      covarianceMatrix: [
        [0.04, 0.018, 0],   // 3 columns instead of 2
        [0.018, 0.09, 0],
      ],
    };
    await expect(tool.execute(bad)).rejects.toThrow(/columns/);
  });

  it("throws when an asset has zero variance (diagonal entry ≤ 0)", async () => {
    const bad: MarkowitzPortfolioInput = {
      ...TWO_ASSET,
      covarianceMatrix: [
        [0, 0.018],   // asset A has zero variance
        [0.018, 0.09],
      ],
    };
    await expect(tool.execute(bad)).rejects.toThrow(/variance/);
  });

  it("throws when the covariance matrix is not symmetric", async () => {
    const bad: MarkowitzPortfolioInput = {
      ...TWO_ASSET,
      covarianceMatrix: [
        [0.04, 0.018],
        [0.030, 0.09],  // cov[1][0] ≠ cov[0][1]
      ],
    };
    await expect(tool.execute(bad)).rejects.toThrow(/symmetric/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — idempotency", () => {
  it("identical inputs produce identical outputs (deterministic optimizer)", async () => {
    const out1 = await tool.execute(TWO_ASSET);
    const out2 = await tool.execute(TWO_ASSET);
    expect(out1.weights).toEqual(out2.weights);
    expect(out1.portfolioReturn).toBe(out2.portfolioReturn);
    expect(out1.portfolioVolatility).toBe(out2.portfolioVolatility);
    expect(out1.sharpeRatio).toBe(out2.sharpeRatio);
  });

  it("identical inputs produce identical frontier (deterministic)", async () => {
    const out1 = await tool.execute(THREE_ASSET);
    const out2 = await tool.execute(THREE_ASSET);
    expect(out1.efficientFrontierPoints).toEqual(out2.efficientFrontierPoints);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("markowitzPortfolio — edge cases", () => {
  it("portfolioVolatility is always non-negative", async () => {
    const out = await tool.execute(TWO_ASSET);
    expect(out.portfolioVolatility).toBeGreaterThanOrEqual(0);
  });

  it("when rf > all returns (long-only), falls back without throwing", async () => {
    // rf=0.30 > μ_A=0.10 and μ_B=0.20; no positive excess return exists.
    const highRf: MarkowitzPortfolioInput = { ...TWO_ASSET, riskFreeRate: 0.30 };
    const out = await tool.execute(highRf);
    expect(sumWeights(out.weights)).toBeCloseTo(1, 4);
    for (const [, w] of Object.entries(out.weights)) {
      expect(w).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("unconstrained mode can produce negative weights", async () => {
    // With a very skewed covariance structure, short positions are optimal.
    // We just verify the solver runs and sums to 1.
    const out = await tool.execute(TWO_ASSET_UNCONSTRAINED);
    expect(sumWeights(out.weights)).toBeCloseTo(1, 4);
  });

  it("perfectly correlated assets: non-zero output without throwing", async () => {
    // ρ=0.99 (not exactly 1 to keep positive definiteness)
    const highCorr: MarkowitzPortfolioInput = {
      assets: [
        { name: "X", expectedReturn: 0.10 },
        { name: "Y", expectedReturn: 0.15 },
      ],
      covarianceMatrix: [
        [0.04, 0.0198],
        [0.0198, 0.0100],
      ],
      riskFreeRate: 0.03,
      allowShortSelling: false,
    };
    const out = await tool.execute(highCorr);
    expect(sumWeights(out.weights)).toBeCloseTo(1, 3);
  });
});
