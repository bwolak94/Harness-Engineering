import type { ToolDefinition } from "@harness/contracts";
import {
  type AnalyzeInvestmentInput,
  AnalyzeInvestmentInputSchema,
  type AnalyzeInvestmentOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Financial math helpers
// ---------------------------------------------------------------------------

/** Annual payment for an annuity loan (constant payments). */
function annuityPayment(principal: number, rateAnnual: number, termYears: number): number {
  if (rateAnnual === 0) return principal / termYears;
  const r = rateAnnual;
  return (principal * r * (1 + r) ** termYears) / ((1 + r) ** termYears - 1);
}

/** Annual payments for a decreasing (straight-line) loan schedule. */
function decreasingSchedule(principal: number, rateAnnual: number, termYears: number): number[] {
  const principalPayment = principal / termYears;
  const schedule: number[] = [];
  let remaining = principal;
  for (let i = 0; i < termYears; i++) {
    schedule.push(principalPayment + remaining * rateAnnual);
    remaining -= principalPayment;
  }
  return schedule;
}

/** Outstanding balance of an annuity loan after `t` full years. */
function annuityRemainingBalance(
  principal: number,
  rateAnnual: number,
  termYears: number,
  t: number,
): number {
  if (rateAnnual === 0) return principal * Math.max(0, 1 - t / termYears);
  const r = rateAnnual;
  return (principal * ((1 + r) ** termYears - (1 + r) ** t)) / ((1 + r) ** termYears - 1);
}

/**
 * IRR via bisection (100 iterations, precision ~1e-10).
 * Returns NaN if cashflows never change sign (no real IRR exists).
 */
function computeIRR(cashflows: readonly number[]): number {
  const npvAt = (r: number): number => cashflows.reduce((sum, cf, t) => sum + cf / (1 + r) ** t, 0);

  let lo = -0.9999;
  let hi = 10.0;

  if (npvAt(lo) * npvAt(hi) > 0) return Number.NaN;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(hi - lo) < 1e-10) break;
    if (npvAt(mid) * npvAt(lo) > 0) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createAnalyzeInvestmentTool(
  definition: ToolDefinition,
): Tool<AnalyzeInvestmentInput, AnalyzeInvestmentOutput> {
  return {
    definition,
    inputSchema: AnalyzeInvestmentInputSchema,

    async execute(input) {
      const assumptions: string[] = [];

      // Gross potential rent (100 % occupancy)
      const grossPotentialRent = input.rentRoll.reduce((sum, u) => sum + u.monthlyRent * 12, 0);

      // Effective gross income — weighted by unit occupancy
      const effectiveGrossIncome = input.rentRoll.reduce(
        (sum, u) => sum + u.monthlyRent * 12 * (u.occupancyPct / 100),
        0,
      );
      assumptions.push(
        `Effective gross income: ${effectiveGrossIncome.toFixed(2)} (weighted by occupancy across ${input.rentRoll.length} unit(s))`,
      );

      const annualOpex = input.opex.reduce((sum, e) => sum + e.annualAmount, 0);
      const noi = effectiveGrossIncome - annualOpex;
      assumptions.push(
        `NOI = EGI ${effectiveGrossIncome.toFixed(2)} − opex ${annualOpex.toFixed(2)} = ${noi.toFixed(2)}`,
      );

      const capRate = input.price > 0 ? noi / input.price : 0;

      const { loan } = input;
      const rateAnnual = loan.rateAnnualPct / 100;
      const equity = input.price - loan.amount;
      assumptions.push(
        `Equity = price ${input.price} − loan ${loan.amount} = ${equity.toFixed(2)}`,
      );

      // Pre-compute annuity payment or decreasing schedule
      const annuityDs =
        loan.type === "annuity" ? annuityPayment(loan.amount, rateAnnual, loan.termYears) : 0;
      const decSchedule =
        loan.type === "decreasing"
          ? decreasingSchedule(loan.amount, rateAnnual, loan.termYears)
          : [];

      const debtServiceYear1 = loan.type === "annuity" ? annuityDs : (decSchedule[0] ?? 0);

      assumptions.push(
        `Loan type: ${loan.type}, year-1 debt service: ${debtServiceYear1.toFixed(2)}, rate: ${loan.rateAnnualPct}%, term: ${loan.termYears} yr`,
      );

      const cashOnCash = equity > 0 ? (noi - debtServiceYear1) / equity : 0;
      const dscr = debtServiceYear1 > 0 ? noi / debtServiceYear1 : Number.POSITIVE_INFINITY;

      const breakEvenOccupancy =
        grossPotentialRent > 0 ? ((annualOpex + debtServiceYear1) / grossPotentialRent) * 100 : 0;
      assumptions.push(`Break-even occupancy: ${breakEvenOccupancy.toFixed(1)}%`);

      // Build cashflow array: index 0 = year 0 (equity outflow)
      const cashflows: number[] = [-equity];

      for (let t = 1; t <= input.horizonYears; t++) {
        let ds = 0;
        if (t <= loan.termYears) {
          ds = loan.type === "annuity" ? annuityDs : (decSchedule[t - 1] ?? 0);
        }

        let cf = noi - ds;

        if (t === input.horizonYears) {
          const exitValue = noi / input.exitCapRate;
          const remainingLoan =
            loan.type === "annuity"
              ? annuityRemainingBalance(
                  loan.amount,
                  rateAnnual,
                  loan.termYears,
                  Math.min(t, loan.termYears),
                )
              : Math.max(
                  0,
                  loan.amount - (loan.amount / loan.termYears) * Math.min(t, loan.termYears),
                );

          const netProceeds = exitValue - remainingLoan;
          cf += netProceeds;
          assumptions.push(
            `Exit year ${t}: value ${exitValue.toFixed(2)} at cap rate ${input.exitCapRate * 100}%, remaining loan ${remainingLoan.toFixed(2)}, net proceeds ${netProceeds.toFixed(2)}`,
          );
        }

        cashflows.push(cf);
      }

      const DISCOUNT_RATE = 0.1;
      const npv = cashflows.reduce((sum, cf, t) => sum + cf / (1 + DISCOUNT_RATE) ** t, 0);
      assumptions.push(`NPV at ${DISCOUNT_RATE * 100}% discount rate: ${npv.toFixed(2)}`);

      const irr = computeIRR(cashflows);

      return {
        noi,
        capRate,
        cashOnCash,
        irr: Number.isNaN(irr) ? 0 : irr,
        npv,
        dscr,
        breakEvenOccupancy,
        cashflows,
        assumptions,
      };
    },
  };
}
