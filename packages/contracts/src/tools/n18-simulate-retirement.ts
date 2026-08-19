import { z } from "zod";

export const AssetAllocationSchema = z
  .object({
    equityPct: z.number().min(0).max(100),
    bondPct: z.number().min(0).max(100),
    cashPct: z.number().min(0).max(100),
  })
  .refine((a) => Math.abs(a.equityPct + a.bondPct + a.cashPct - 100) < 0.01, {
    message: "equityPct + bondPct + cashPct must equal 100",
  });

export const SimulateRetirementInputSchema = z.object({
  currentAge: z.number().int().min(18).max(80),
  retirementAge: z.number().int().min(40).max(90),
  lifeExpectancy: z.number().int().min(60).max(120).default(90),
  currentSavingsUsd: z.number().nonnegative(),
  annualContributionUsd: z
    .number()
    .nonnegative()
    .describe("Additional savings added per year until retirement"),
  targetMonthlyWithdrawalUsd: z
    .number()
    .positive()
    .describe("Required monthly income (real, today's dollars) during retirement"),
  portfolio: AssetAllocationSchema,
  inflationRatePct: z.number().min(0).max(20).default(2.5),
  simulations: z.number().int().min(100).max(10000).default(1000),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Optional PRNG seed for deterministic results; omit for true Monte Carlo"),
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const RetirementPercentilesSchema = z.object({
  p10: z.number().describe("10th percentile savings at retirement age"),
  p25: z.number(),
  p50: z.number().describe("Median"),
  p75: z.number(),
  p90: z.number(),
});

export const RetirementAdjustmentSchema = z.object({
  type: z.enum([
    "increase_contribution",
    "delay_retirement",
    "reduce_withdrawal",
    "increase_equity",
  ]),
  description: z.string(),
  estimatedImpactPct: z
    .number()
    .describe("Estimated improvement in success probability (percentage points)"),
});

export const SimulateRetirementOutputSchema = z.object({
  successProbabilityPct: z
    .number()
    .min(0)
    .max(100)
    .describe("% of simulations where savings last through lifeExpectancy"),
  savingsAtRetirement: RetirementPercentilesSchema,
  yearsOfFundingSufficiency: z
    .object({
      p10: z.number().describe("Savings run out after this many years in the worst 10% of paths"),
      p50: z.number(),
      p90: z.number(),
    })
    .describe("How many years post-retirement the portfolio lasts in each percentile"),
  recommendedAdjustments: z.array(RetirementAdjustmentSchema).max(4),
  assumptions: z.array(z.string()),
});

export type AssetAllocation = z.infer<typeof AssetAllocationSchema>;
export type SimulateRetirementInput = z.infer<typeof SimulateRetirementInputSchema>;
export type SimulateRetirementOutput = z.infer<typeof SimulateRetirementOutputSchema>;
