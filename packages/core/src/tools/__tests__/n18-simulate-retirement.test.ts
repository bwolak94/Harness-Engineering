import { describe, expect, it } from "vitest";
import { createSimulateRetirementTool } from "../n18-simulate-retirement.js";

const DEF = {
  name: "simulateRetirement",
  description: "test",
  dangerous: false,
  idempotent: false,
  costHint: "moderate" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createSimulateRetirementTool(DEF);

const BASE_INPUT = {
  currentAge: 35,
  retirementAge: 65,
  lifeExpectancy: 90,
  currentSavingsUsd: 120_000,
  annualContributionUsd: 18_000,
  targetMonthlyWithdrawalUsd: 4_000,
  portfolio: { equityPct: 70, bondPct: 25, cashPct: 5 },
  inflationRatePct: 2.5,
  simulations: 500,
  seed: 42,
};

describe("N18 simulateRetirement", () => {
  it("returns successProbabilityPct in [0, 100]", async () => {
    const result = await tool.execute(BASE_INPUT);
    expect(result.successProbabilityPct).toBeGreaterThanOrEqual(0);
    expect(result.successProbabilityPct).toBeLessThanOrEqual(100);
  });

  it("percentile values are monotonically increasing", async () => {
    const result = await tool.execute(BASE_INPUT);
    const { p10, p25, p50, p75, p90 } = result.savingsAtRetirement;
    expect(p10).toBeLessThanOrEqual(p25);
    expect(p25).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(p90);
  });

  it("yearsOfFundingSufficiency percentiles are monotonically increasing", async () => {
    const result = await tool.execute(BASE_INPUT);
    const { p10, p50, p90 } = result.yearsOfFundingSufficiency;
    expect(p10).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p90);
  });

  it("p50 savings at retirement is positive for typical inputs", async () => {
    const result = await tool.execute(BASE_INPUT);
    expect(result.savingsAtRetirement.p50).toBeGreaterThan(0);
  });

  it("same seed produces identical results (determinism)", async () => {
    const r1 = await tool.execute(BASE_INPUT);
    const r2 = await tool.execute(BASE_INPUT);
    expect(r1.successProbabilityPct).toBe(r2.successProbabilityPct);
    expect(r1.savingsAtRetirement.p50).toBe(r2.savingsAtRetirement.p50);
  });

  it("different seeds produce different results", async () => {
    const r1 = await tool.execute({ ...BASE_INPUT, seed: 1 });
    const r2 = await tool.execute({ ...BASE_INPUT, seed: 99999 });
    // With 500 simulations there should almost certainly be a difference
    expect(r1.successProbabilityPct).not.toBe(r2.successProbabilityPct);
  });

  it("zero savings and zero contribution yields low success probability", async () => {
    const result = await tool.execute({
      ...BASE_INPUT,
      currentSavingsUsd: 0,
      annualContributionUsd: 0,
      simulations: 200,
    });
    expect(result.successProbabilityPct).toBeLessThan(10);
  });

  it("very large savings yields high success probability", async () => {
    const result = await tool.execute({
      ...BASE_INPUT,
      currentSavingsUsd: 5_000_000,
      annualContributionUsd: 50_000,
      targetMonthlyWithdrawalUsd: 3_000,
      simulations: 200,
    });
    expect(result.successProbabilityPct).toBeGreaterThan(80);
  });

  it("returns at most 4 recommended adjustments", async () => {
    const result = await tool.execute(BASE_INPUT);
    expect(result.recommendedAdjustments.length).toBeLessThanOrEqual(4);
  });

  it("all recommendations have estimatedImpactPct > 0", async () => {
    const result = await tool.execute({
      ...BASE_INPUT,
      currentSavingsUsd: 1000,
      annualContributionUsd: 500,
    });
    for (const rec of result.recommendedAdjustments) {
      expect(rec.estimatedImpactPct).toBeGreaterThan(0);
    }
  });

  it("includes assumptions array with portfolio and simulation info", async () => {
    const result = await tool.execute(BASE_INPUT);
    expect(result.assumptions.some((a) => a.includes("70%"))).toBe(true); // equity pct
    expect(result.assumptions.some((a) => a.includes("500"))).toBe(true); // simulations
  });

  it("throws when retirementAge <= currentAge", async () => {
    await expect(tool.execute({ ...BASE_INPUT, retirementAge: 35 })).rejects.toThrow(
      /retirementAge/,
    );
  });

  it("shorter accumulation phase results in lower median savings", async () => {
    const long = await tool.execute({ ...BASE_INPUT, currentAge: 25, retirementAge: 65 });
    const short = await tool.execute({ ...BASE_INPUT, currentAge: 55, retirementAge: 65 });
    expect(long.savingsAtRetirement.p50).toBeGreaterThan(short.savingsAtRetirement.p50);
  });
});
