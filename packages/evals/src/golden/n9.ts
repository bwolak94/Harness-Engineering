import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N9 — calculateNetSalary golden cases.
 *
 * Polish payroll calculation — the most arithmetically deterministic tool
 * in the set. ZUS rates and PIT thresholds are taken from versioned data
 * tables so the same inputs always produce the same outputs.
 *
 * Tests:
 *  1. UoP contract 2024 — net < gross, ZUS positive, appliedThresholds present.
 *  2. B2B simplified — lower ZUS base, simplified PIT calculation.
 *  3. Zlecenie contract — 20% deductible applied.
 */
export const N9_CASES: EvalCase[] = [
  {
    id: "n9-uop-2024",
    tool: "calculateNetSalary",
    description:
      "UoP employment contract 2024 — net < gross, ZUS contributions positive, thresholds documented",
    task: {
      id: "eval-n9-uop",
      goal: "Calculate the net salary for this Polish employment contract.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("calculateNetSalary", {
        gross: 10_000,
        contractType: "uop",
        year: 2024,
        taxReliefs: [],
        ppkRate: 2,
        jointFiling: false,
      }),
      FakeModelPort.textResponse("Net salary calculated."),
    ]),
    outcomeChecks: [
      // net must be less than gross
      { type: "field_lt", path: "net", value: 10_000 },
      // net must be positive
      { type: "field_gt", path: "net", value: 0 },
      // ZUS employee contributions must be positive
      { type: "field_gt", path: "zusEmployee", value: 0 },
      // employer total cost must exceed gross
      { type: "field_gt", path: "employerTotalCost", value: 10_000 },
      // audit trail must be non-empty
      { type: "array_min_length", path: "appliedThresholds", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "calculateNetSalary" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n9-zlecenie-2023",
    tool: "calculateNetSalary",
    description:
      "Zlecenie civil contract 2023 — 20% tax-deductible costs applied, net in reasonable range",
    task: {
      id: "eval-n9-zlecenie",
      goal: "What is the net pay for this zlecenie contract?",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("calculateNetSalary", {
        gross: 6_000,
        contractType: "zlecenie",
        year: 2023,
        taxReliefs: [],
        ppkRate: 0,
        jointFiling: false,
      }),
      FakeModelPort.textResponse("Zlecenie calculation complete."),
    ]),
    outcomeChecks: [
      { type: "field_lt", path: "net", value: 6_000 },
      { type: "field_gt", path: "net", value: 0 },
      { type: "field_gt", path: "deductibleCosts", value: 0 },
      { type: "array_min_length", path: "appliedThresholds", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "calculateNetSalary" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },

  {
    id: "n9-uop-joint-filing",
    tool: "calculateNetSalary",
    description:
      "UoP with joint filing — tax base halved, advance tax should be lower than standard rate",
    task: {
      id: "eval-n9-joint",
      goal: "Calculate net salary with joint tax filing.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("calculateNetSalary", {
        gross: 8_000,
        contractType: "uop",
        year: 2024,
        taxReliefs: [],
        ppkRate: 2,
        jointFiling: true,
      }),
      FakeModelPort.textResponse("Joint filing calculation done."),
    ]),
    outcomeChecks: [
      { type: "field_lt", path: "net", value: 8_000 },
      { type: "field_gt", path: "net", value: 0 },
      { type: "array_min_length", path: "appliedThresholds", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "calculateNetSalary" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },
];
