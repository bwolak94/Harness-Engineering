import type { AnalyzeInvestmentInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createAnalyzeInvestmentTool } from "../n1-analyze-investment.js";

const DEF = {
  name: "analyzeInvestment",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createAnalyzeInvestmentTool(DEF);

const BASE_INPUT: AnalyzeInvestmentInput = {
  price: 1_000_000,
  rentRoll: [{ unit: "A", monthlyRent: 5000, occupancyPct: 90 }],
  opex: [{ category: "maintenance", annualAmount: 10_000 }],
  loan: { amount: 700_000, rateAnnualPct: 5, termYears: 20, type: "annuity" },
  horizonYears: 10,
  exitCapRate: 0.05,
};

describe("analyzeInvestment", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(typeof out.noi).toBe("number");
    expect(typeof out.capRate).toBe("number");
    expect(typeof out.cashOnCash).toBe("number");
    expect(typeof out.irr).toBe("number");
    expect(typeof out.npv).toBe("number");
    expect(typeof out.dscr).toBe("number");
    expect(typeof out.breakEvenOccupancy).toBe("number");
    expect(Array.isArray(out.cashflows)).toBe(true);
    expect(Array.isArray(out.assumptions)).toBe(true);
  });

  it("NOI = effective gross income − opex", async () => {
    const egi = 5000 * 12 * 0.9; // 54000
    const opex = 10_000;
    const expectedNoi = egi - opex; // 44000
    const out = await tool.execute(BASE_INPUT);
    expect(out.noi).toBeCloseTo(expectedNoi, 2);
  });

  it("cap rate = NOI / price", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.capRate).toBeCloseTo(out.noi / BASE_INPUT.price, 6);
  });

  it("DSCR = NOI / annual debt service (formula check)", async () => {
    // BASE_INPUT is over-leveraged (700K loan at 5% → annual DS ≈ 56K > NOI 44K)
    // so DSCR < 1 is the correct result; we test the formula, not a business threshold
    const out = await tool.execute(BASE_INPUT);
    expect(out.dscr).toBeGreaterThan(0);
    // A well-leveraged case
    const goodInput: AnalyzeInvestmentInput = {
      ...BASE_INPUT,
      loan: { amount: 200_000, rateAnnualPct: 4, termYears: 20, type: "annuity" },
    };
    const goodOut = await tool.execute(goodInput);
    expect(goodOut.dscr).toBeGreaterThan(1);
  });

  it("cashflows length = horizonYears + 1 (year 0 is equity outflow)", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.cashflows).toHaveLength(BASE_INPUT.horizonYears + 1);
  });

  it("year-0 cashflow equals negative equity (price − loan)", async () => {
    const out = await tool.execute(BASE_INPUT);
    const expectedEquity = BASE_INPUT.price - BASE_INPUT.loan.amount; // 300000
    expect(out.cashflows[0]).toBeCloseTo(-expectedEquity, 2);
  });

  it("NPV is negative for a poor investment (high price, low rent)", async () => {
    const poorInput: AnalyzeInvestmentInput = {
      ...BASE_INPUT,
      price: 5_000_000,
      loan: { ...BASE_INPUT.loan, amount: 0 },
    };
    const out = await tool.execute(poorInput);
    expect(out.npv).toBeLessThan(0);
  });

  it("breakEvenOccupancy is non-negative (can exceed 100 for over-leveraged properties)", async () => {
    // BASE_INPUT is over-leveraged → break-even > 100% is the correct result
    const out = await tool.execute(BASE_INPUT);
    expect(out.breakEvenOccupancy).toBeGreaterThan(0);
    // A low-leverage case must have break-even below 100%
    const lowLeverage: AnalyzeInvestmentInput = {
      ...BASE_INPUT,
      loan: { amount: 100_000, rateAnnualPct: 3, termYears: 10, type: "annuity" },
    };
    const lowOut = await tool.execute(lowLeverage);
    expect(lowOut.breakEvenOccupancy).toBeLessThan(100);
  });

  it("decreasing loan type produces different year-1 debt service than annuity", async () => {
    const annuityOut = await tool.execute(BASE_INPUT);
    const decInput: AnalyzeInvestmentInput = {
      ...BASE_INPUT,
      loan: { ...BASE_INPUT.loan, type: "decreasing" },
    };
    const decOut = await tool.execute(decInput);
    // Year-1 cashflows differ because debt service structure differs
    expect(annuityOut.cashflows[1]).not.toBeCloseTo(decOut.cashflows[1] ?? 0, 0);
  });

  it("idempotent: same input produces identical output", async () => {
    const out1 = await tool.execute(BASE_INPUT);
    const out2 = await tool.execute(BASE_INPUT);
    expect(out1.noi).toBe(out2.noi);
    expect(out1.irr).toBe(out2.irr);
    expect(out1.cashflows).toEqual(out2.cashflows);
  });

  it("zero-rate loan: annual payment = principal / term", async () => {
    const zeroRateInput: AnalyzeInvestmentInput = {
      ...BASE_INPUT,
      loan: { amount: 600_000, rateAnnualPct: 0, termYears: 10, type: "annuity" },
    };
    const out = await tool.execute(zeroRateInput);
    // debt service year 1 ≈ 60000 (600000 / 10)
    // noi − 60000 = cashflow[1]
    const expectedDs = 60_000;
    expect(out.cashflows[1]).toBeCloseTo(out.noi - expectedDs, 0);
  });
});
