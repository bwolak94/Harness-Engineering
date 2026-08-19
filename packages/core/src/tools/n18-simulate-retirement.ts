import type { ToolDefinition } from "@harness/contracts";
import type { SimulateRetirementInput, SimulateRetirementOutput } from "@harness/contracts/tools";
import { SimulateRetirementInputSchema } from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Expected return and volatility parameters by asset class (nominal, annual)
// Source: long-run historical averages; user-supplied allocation determines blend.
// ---------------------------------------------------------------------------

const ASSET_PARAMS = {
  equity: { meanReturn: 0.07, stdDev: 0.15 },
  bond: { meanReturn: 0.03, stdDev: 0.05 },
  cash: { meanReturn: 0.015, stdDev: 0.005 },
} as const;

// ---------------------------------------------------------------------------
// Seeded 64-bit LCG (Knuth MMIX constants, adapted to JS numbers)
// Returns values in [0, 1).
// ---------------------------------------------------------------------------

function makeLcg(seed: number) {
  // Use BigInt internally to avoid float precision issues in the multiplier
  let state = BigInt(seed >>> 0) ^ 0x12345678n;
  return function nextFloat(): number {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    // Take upper 32 bits, map to [0,1)
    return Number((state >> 32n) & 0xffffffffn) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Box-Muller transform → standard normal sample
// ---------------------------------------------------------------------------

function normalSample(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-15); // avoid log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Blend portfolio parameters
// ---------------------------------------------------------------------------

function blendedParams(
  equityPct: number,
  bondPct: number,
  cashPct: number,
): { mean: number; stdDev: number } {
  const e = equityPct / 100;
  const b = bondPct / 100;
  const c = cashPct / 100;

  // Blended mean return (weighted sum)
  const mean =
    e * ASSET_PARAMS.equity.meanReturn +
    b * ASSET_PARAMS.bond.meanReturn +
    c * ASSET_PARAMS.cash.meanReturn;

  // Simplified blended volatility (ignoring cross-correlations for planning purposes)
  const variance =
    e ** 2 * ASSET_PARAMS.equity.stdDev ** 2 +
    b ** 2 * ASSET_PARAMS.bond.stdDev ** 2 +
    c ** 2 * ASSET_PARAMS.cash.stdDev ** 2;

  return { mean, stdDev: Math.sqrt(variance) };
}

// ---------------------------------------------------------------------------
// Single simulation path — returns years the portfolio is funded post-retirement
// ---------------------------------------------------------------------------

function runOnePath(
  yearsToRetirement: number,
  yearsInRetirement: number,
  currentSavings: number,
  annualContribution: number,
  targetAnnualWithdrawal: number,
  blended: { mean: number; stdDev: number },
  inflationRate: number,
  rng: () => number,
): { savingsAtRetirement: number; yearsFunded: number } {
  // --- Accumulation phase ---
  let portfolio = currentSavings;
  for (let yr = 0; yr < yearsToRetirement; yr++) {
    // Geometric Brownian Motion step
    const returnRate =
      blended.mean - 0.5 * blended.stdDev ** 2 + blended.stdDev * normalSample(rng);
    portfolio = (portfolio + annualContribution) * (1 + returnRate);
    if (portfolio < 0) portfolio = 0;
  }
  const savingsAtRetirement = portfolio;

  // --- Distribution phase ---
  let yearsFunded = 0;
  // Inflation-adjust withdrawal each year
  let withdrawal = targetAnnualWithdrawal;
  for (let yr = 0; yr < yearsInRetirement; yr++) {
    withdrawal *= 1 + inflationRate / 100;
    const returnRate =
      blended.mean - 0.5 * blended.stdDev ** 2 + blended.stdDev * normalSample(rng);
    portfolio = portfolio * (1 + returnRate) - withdrawal;
    if (portfolio <= 0) break;
    yearsFunded++;
  }
  if (portfolio > 0) yearsFunded = yearsInRetirement;

  return { savingsAtRetirement, yearsFunded };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createSimulateRetirementTool(
  definition: ToolDefinition,
): Tool<SimulateRetirementInput, SimulateRetirementOutput> {
  return {
    definition,
    inputSchema: SimulateRetirementInputSchema,

    async execute(input) {
      const assumptions: string[] = [];

      const yearsToRetirement = input.retirementAge - input.currentAge;
      const yearsInRetirement = input.lifeExpectancy - input.retirementAge;

      if (yearsToRetirement <= 0) throw new Error("retirementAge must be greater than currentAge");
      if (yearsInRetirement <= 0)
        throw new Error("lifeExpectancy must be greater than retirementAge");

      const blended = blendedParams(
        input.portfolio.equityPct,
        input.portfolio.bondPct,
        input.portfolio.cashPct,
      );
      const targetAnnualWithdrawal = input.targetMonthlyWithdrawalUsd * 12;

      assumptions.push(
        `Blended portfolio: mean return ${(blended.mean * 100).toFixed(2)}%, ` +
          `volatility ${(blended.stdDev * 100).toFixed(2)}% ` +
          `(equity ${input.portfolio.equityPct}% / bond ${input.portfolio.bondPct}% / cash ${input.portfolio.cashPct}%)`,
      );
      assumptions.push(
        `Accumulation phase: ${yearsToRetirement} years; ` +
          `distribution phase: ${yearsInRetirement} years`,
      );
      assumptions.push(
        `Annual contribution: $${input.annualContributionUsd.toLocaleString()}; ` +
          `target annual withdrawal (today's dollars): $${targetAnnualWithdrawal.toLocaleString()}`,
      );
      assumptions.push(`Inflation: ${input.inflationRatePct}% p.a. (applied to withdrawals)`);
      assumptions.push(
        `Simulation: ${input.simulations} paths, ${input.seed !== undefined ? `seed=${input.seed}` : "random seed"}`,
      );

      const seed = input.seed ?? Date.now();
      const rng = makeLcg(seed);

      const savingsResults: number[] = [];
      const yearsFundedResults: number[] = [];

      for (let i = 0; i < input.simulations; i++) {
        const { savingsAtRetirement, yearsFunded } = runOnePath(
          yearsToRetirement,
          yearsInRetirement,
          input.currentSavingsUsd,
          input.annualContributionUsd,
          targetAnnualWithdrawal,
          blended,
          input.inflationRatePct,
          rng,
        );
        savingsResults.push(savingsAtRetirement);
        yearsFundedResults.push(yearsFunded);
      }

      savingsResults.sort((a, b) => a - b);
      yearsFundedResults.sort((a, b) => a - b);

      const successCount = yearsFundedResults.filter((y) => y >= yearsInRetirement).length;
      const successProbabilityPct = (successCount / input.simulations) * 100;

      const pct = (arr: number[], p: number) => arr[Math.floor((p / 100) * arr.length)] ?? 0;

      // Recommendations
      const recommendations: SimulateRetirementOutput["recommendedAdjustments"] = [];

      if (successProbabilityPct < 90) {
        const boostAmount = Math.round((input.annualContributionUsd * 0.2) / 100) * 100;
        recommendations.push({
          type: "increase_contribution",
          description: `Increase annual contribution by $${boostAmount.toLocaleString()} (20%)`,
          estimatedImpactPct: round1(Math.min(15, (90 - successProbabilityPct) * 0.4)),
        });
      }

      if (successProbabilityPct < 80 && yearsToRetirement < 35) {
        recommendations.push({
          type: "delay_retirement",
          description:
            "Delay retirement by 2 years to extend accumulation and reduce withdrawal period",
          estimatedImpactPct: round1(Math.min(12, (80 - successProbabilityPct) * 0.5)),
        });
      }

      if (successProbabilityPct < 75) {
        const reducedWithdrawal = Math.round(input.targetMonthlyWithdrawalUsd * 0.85);
        recommendations.push({
          type: "reduce_withdrawal",
          description: `Reduce target monthly withdrawal to $${reducedWithdrawal.toLocaleString()} (−15%)`,
          estimatedImpactPct: round1(Math.min(20, (80 - successProbabilityPct) * 0.6)),
        });
      }

      if (input.portfolio.equityPct < 50 && yearsToRetirement > 10) {
        recommendations.push({
          type: "increase_equity",
          description: `Increase equity allocation from ${input.portfolio.equityPct}% to ${Math.min(80, input.portfolio.equityPct + 20)}% to boost long-run growth`,
          estimatedImpactPct: round1(5 + (50 - input.portfolio.equityPct) * 0.1),
        });
      }

      return {
        successProbabilityPct: round1(successProbabilityPct),
        savingsAtRetirement: {
          p10: round0(pct(savingsResults, 10)),
          p25: round0(pct(savingsResults, 25)),
          p50: round0(pct(savingsResults, 50)),
          p75: round0(pct(savingsResults, 75)),
          p90: round0(pct(savingsResults, 90)),
        },
        yearsOfFundingSufficiency: {
          p10: round1(pct(yearsFundedResults, 10)),
          p50: round1(pct(yearsFundedResults, 50)),
          p90: round1(pct(yearsFundedResults, 90)),
        },
        recommendedAdjustments: recommendations.slice(0, 4),
        assumptions,
      };
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round0(n: number): number {
  return Math.round(n);
}
