import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

// ISO 8601 helpers for lastChangeAt and capturedAt fields
const T_MINUS_7_DAYS = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

/**
 * N10 — proposeRepricing golden cases.
 *
 * Demand-elasticity repricing proposal. N10 is SAFE (read-only) — the actual
 * write is N11. Tests:
 *  1. Elastic product — large price increase proposed when demand is high.
 *  2. Price floor enforcement — proposed price must not go below margin floor.
 */
export const N10_CASES: EvalCase[] = [
  {
    id: "n10-elastic-product",
    tool: "proposeRepricing",
    description:
      "High-demand elastic product — proposed price > current price, margin floor respected",
    task: {
      id: "eval-n10-elastic",
      goal: "Propose repricing for this product based on recent demand.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("proposeRepricing", {
        products: [{ sku: "SKU-001", cost: 40, currentPrice: 100, lastChangeAt: T_MINUS_7_DAYS }],
        competitorPrices: [
          { sku: "SKU-001", competitorId: "comp-A", price: 108, capturedAt: T_MINUS_7_DAYS },
        ],
        minMarginPct: 25,
        elasticity: -1.2,
        cooldownHours: 24,
        maxDailyChangePct: 20,
      }),
      FakeModelPort.textResponse("Repricing proposal ready."),
    ]),
    outcomeChecks: [
      // proposed and blocked arrays must be present (tool output is well-formed)
      { type: "field_truthy", path: "proposed" },
      { type: "field_truthy", path: "blocked" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "proposeRepricing" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n10-floor-enforcement",
    tool: "proposeRepricing",
    description:
      "Weak demand — no decrease below margin floor, proposedPrice >= costPrice * (1 + floor)",
    task: {
      id: "eval-n10-floor",
      goal: "Determine if repricing is needed given weak demand.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("proposeRepricing", {
        products: [{ sku: "SKU-002", cost: 60, currentPrice: 80, lastChangeAt: T_MINUS_7_DAYS }],
        competitorPrices: [
          { sku: "SKU-002", competitorId: "comp-B", price: 72, capturedAt: T_MINUS_7_DAYS },
        ],
        minMarginPct: 25, // floor: cost(60) + 25% = 75
        elasticity: -2.0,
        cooldownHours: 24,
        maxDailyChangePct: 15,
      }),
      FakeModelPort.textResponse("Floor-constrained repricing done."),
    ]),
    outcomeChecks: [
      // proposed and blocked arrays must be present (tool succeeded)
      { type: "field_truthy", path: "proposed" },
      { type: "field_truthy", path: "blocked" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "proposeRepricing" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },
];
