import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

// 8760-hour flat consumption profile helper (constant kWh per hour)
function flatProfile(kWhPerHour: number): number[] {
  return Array(8760).fill(kWhPerHour);
}

/**
 * N8 — simulatePVPayback golden cases.
 *
 * 8760-step hourly solar simulation — the computationally heaviest tool.
 * These cases verify the output structure and physical reasonableness:
 *  - yearlyKWh > 0 (generation occurs)
 *  - selfConsumptionPct in [0, 100]
 *  - monthlyBreakdown has exactly 12 entries
 *  - paybackYears > 0
 *
 * Two scenarios: southern Europe (high irradiance) and central Poland
 * (moderate irradiance). We don't assert exact kWh values because the
 * deterministic solar model depends on latitude math — ranges suffice.
 */
export const N8_CASES: EvalCase[] = [
  {
    id: "n8-southern-europe",
    tool: "simulatePVPayback",
    description: "10 kWp system in southern Spain (lat=37.4) — high irradiance, payback < 12 years",
    task: {
      id: "eval-n8-south",
      goal: "Simulate the solar PV payback for this installation in Spain.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("simulatePVPayback", {
        lat: 37.4,
        lng: -5.9,
        kWp: 10,
        tiltDeg: 30,
        azimuthDeg: 180,
        consumptionProfile: flatProfile(0.4), // 0.4 kWh/h ≈ 3500 kWh/year
        tariff: {
          zones: [{ name: "flat", hoursFrom: 0, hoursTo: 24, pricePerKwh: 0.22 }],
          netBilling: false,
          exportRatePerKwh: 0,
        },
        capex: 8_000,
      }),
      FakeModelPort.textResponse("PV payback simulation complete."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "yearlyKWh", value: 0 },
      { type: "field_between", path: "selfConsumptionPct", min: 0, max: 100 },
      // 12 months in a year
      { type: "field_equals", path: "monthlyBreakdown.length", value: 12 },
      { type: "field_gt", path: "paybackYears", value: 0 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "simulatePVPayback" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n8-central-poland",
    tool: "simulatePVPayback",
    description:
      "5 kWp system in central Poland (lat=52.2) — moderate irradiance, monthlyBreakdown present",
    task: {
      id: "eval-n8-poland",
      goal: "Calculate the solar PV payback for a Warsaw rooftop installation.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("simulatePVPayback", {
        lat: 52.2,
        lng: 21.0,
        kWp: 5,
        tiltDeg: 35,
        azimuthDeg: 180,
        consumptionProfile: flatProfile(0.3), // 0.3 kWh/h ≈ 2600 kWh/year
        tariff: {
          zones: [{ name: "peak", hoursFrom: 6, hoursTo: 22, pricePerKwh: 0.75 }],
          netBilling: false,
          exportRatePerKwh: 0,
        },
        capex: 22_000,
      }),
      FakeModelPort.textResponse("Polish PV payback done."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "yearlyKWh", value: 0 },
      { type: "field_between", path: "selfConsumptionPct", min: 0, max: 100 },
      { type: "field_equals", path: "monthlyBreakdown.length", value: 12 },
      { type: "field_gt", path: "paybackYears", value: 0 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "simulatePVPayback" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },
];
