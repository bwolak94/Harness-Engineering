import { z } from "zod";

export const AnalyzeInvestmentInputSchema = z.object({
  price: z.number().positive().describe("Purchase price of the property"),
  rentRoll: z
    .array(
      z.object({
        unit: z.string(),
        monthlyRent: z.number().nonnegative(),
        occupancyPct: z.number().min(0).max(100),
      }),
    )
    .min(1),
  opex: z
    .array(
      z.object({
        category: z.string(),
        annualAmount: z.number().nonnegative(),
      }),
    )
    .default([]),
  loan: z.object({
    amount: z.number().nonnegative(),
    rateAnnualPct: z.number().nonnegative(),
    termYears: z.number().int().positive(),
    type: z.enum(["annuity", "decreasing"]),
  }),
  horizonYears: z.number().int().min(1).max(50),
  exitCapRate: z.number().positive().describe("Cap rate used to estimate exit value"),
});

export const AnalyzeInvestmentOutputSchema = z.object({
  noi: z.number().describe("Net Operating Income (annual)"),
  capRate: z.number().describe("Cap rate at purchase price"),
  cashOnCash: z.number().describe("Cash-on-cash return (year 1)"),
  irr: z.number().describe("Internal Rate of Return over horizon"),
  npv: z.number().describe("Net Present Value at 10% discount rate"),
  dscr: z.number().describe("Debt Service Coverage Ratio (year 1)"),
  breakEvenOccupancy: z.number().describe("Minimum occupancy to cover debt service"),
  cashflows: z.array(z.number()).describe("Annual net cashflows"),
  assumptions: z.array(z.string()).describe("Human-readable list of assumptions applied"),
});

export type AnalyzeInvestmentInput = z.infer<typeof AnalyzeInvestmentInputSchema>;
export type AnalyzeInvestmentOutput = z.infer<typeof AnalyzeInvestmentOutputSchema>;
