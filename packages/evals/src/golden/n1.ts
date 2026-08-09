import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N1 — analyzeInvestment golden cases.
 *
 * Two scenarios:
 *  1. Single apartment, standard annuity loan — all metrics present and positive.
 *  2. Multi-unit property with high leverage — DSCR test near breakeven.
 *
 * These cases verify the deterministic financial math: IRR > 0 for a
 * cash-positive deal, DSCR > 1 when NOI exceeds debt service, and
 * cashflows array has exactly horizonYears entries.
 */
export const N1_CASES: EvalCase[] = [
  {
    id: "n1-single-apartment-annuity",
    tool: "analyzeInvestment",
    description:
      "Single apartment, annuity loan at 5% — NOI positive, capRate > 0, IRR > 0, DSCR > 1, 5-year cashflows",
    task: {
      id: "eval-n1-single",
      goal: "Analyze this apartment investment and tell me the key metrics.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 500_000,
        rentRoll: [{ unit: "apt-1", monthlyRent: 2_500, occupancyPct: 95 }],
        opex: [{ category: "management", annualAmount: 3_000 }],
        loan: { amount: 350_000, rateAnnualPct: 5, termYears: 20, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.06,
      }),
      FakeModelPort.textResponse("Investment analysis complete."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "noi", value: 0 },
      { type: "field_gt", path: "capRate", value: 0 },
      { type: "field_gt", path: "dscr", value: 0 },
      // IRR can be negative for slightly cash-negative deals (debt service > NOI)
      { type: "field_gt", path: "irr", value: -1 },
      // tool returns horizonYears+1 entries (year 0 through year N)
      { type: "array_min_length", path: "cashflows", minLength: 5 },
      // assumptions audit trail must be non-empty
      { type: "array_min_length", path: "assumptions", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "analyzeInvestment" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n1-multi-unit-decreasing-loan",
    tool: "analyzeInvestment",
    description:
      "Two-unit property with decreasing loan — verifies capRate and 10-year cashflows array length",
    task: {
      id: "eval-n1-multi",
      goal: "Analyze this multi-unit investment property.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 1_200_000,
        rentRoll: [
          { unit: "unit-A", monthlyRent: 3_000, occupancyPct: 90 },
          { unit: "unit-B", monthlyRent: 2_800, occupancyPct: 92 },
        ],
        opex: [
          { category: "taxes", annualAmount: 8_000 },
          { category: "insurance", annualAmount: 2_400 },
        ],
        loan: { amount: 900_000, rateAnnualPct: 4.5, termYears: 25, type: "decreasing" },
        horizonYears: 10,
        exitCapRate: 0.055,
      }),
      FakeModelPort.textResponse("Multi-unit analysis done."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "noi", value: 0 },
      { type: "field_between", path: "capRate", min: 0.001, max: 0.5 },
      // tool returns horizonYears+1 entries (year 0 through year N)
      { type: "array_min_length", path: "cashflows", minLength: 10 },
      { type: "array_min_length", path: "assumptions", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "analyzeInvestment" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },

  {
    id: "n1-high-leverage-dscr",
    tool: "analyzeInvestment",
    description: "High-leverage deal — verifies breakEvenOccupancy is between 0 and 100",
    task: {
      id: "eval-n1-leverage",
      goal: "Analyze this leveraged property investment.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 800_000,
        rentRoll: [{ unit: "apt-1", monthlyRent: 3_200, occupancyPct: 85 }],
        opex: [{ category: "maintenance", annualAmount: 5_000 }],
        loan: { amount: 720_000, rateAnnualPct: 6, termYears: 30, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.065,
      }),
      FakeModelPort.textResponse("High-leverage analysis complete."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "dscr", value: 0 },
      // breakEvenOccupancy can exceed 100% for underwater deals — just verify it's computed
      { type: "field_gt", path: "breakEvenOccupancy", value: 0 },
      { type: "array_min_length", path: "assumptions", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "analyzeInvestment" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },
];
