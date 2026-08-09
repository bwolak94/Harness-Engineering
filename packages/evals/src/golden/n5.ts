import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N5 — assessClaim golden cases.
 *
 * Insurance claim assessment with deductible, depreciation, and approval gate.
 * Tests:
 *  1. Small claim — approved, payout < estimated loss after deductible.
 *  2. Large claim with old item — depreciation reduces payout, decision present.
 *  3. Claim exceeding sum insured — underinsurance factor < 1.
 */
export const N5_CASES: EvalCase[] = [
  {
    id: "n5-small-fire-claim",
    tool: "assessClaim",
    description:
      "Small fire claim well within limits — decision present, payout > 0, reasons non-empty",
    task: {
      id: "eval-n5-small",
      goal: "Assess this insurance claim for a fire damage case.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("assessClaim", {
        policy: {
          sumInsured: 50_000,
          deductible: 500,
          deductibleType: "reductive",
          limits: [{ category: "electronics", maxAmount: 5_000 }],
          depreciationTable: [
            { ageYearsFrom: 0, ageYearsTo: 3, depreciationPct: 10 },
            { ageYearsFrom: 3, ageYearsTo: 7, depreciationPct: 30 },
            { ageYearsFrom: 7, ageYearsTo: 100, depreciationPct: 50 },
          ],
        },
        claim: {
          type: "fire",
          estimatedLoss: 2_000,
          itemAge: 1,
        },
        evidence: ["photo-001", "invoice-002"],
      }),
      FakeModelPort.textResponse("Claim assessed."),
    ]),
    outcomeChecks: [
      { type: "field_truthy", path: "decision" },
      { type: "field_gt", path: "payout", value: 0 },
      { type: "field_gt", path: "deductibleApplied", value: 0 },
      { type: "array_min_length", path: "reasons", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "assessClaim" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n5-old-item-depreciation",
    tool: "assessClaim",
    description: "Old item (8 years) — 50% depreciation applied, payout < estimated loss",
    task: {
      id: "eval-n5-old",
      goal: "Assess the insurance claim for this old appliance.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("assessClaim", {
        policy: {
          sumInsured: 20_000,
          deductible: 250,
          deductibleType: "reductive",
          limits: [],
          depreciationTable: [
            { ageYearsFrom: 0, ageYearsTo: 5, depreciationPct: 20 },
            { ageYearsFrom: 5, ageYearsTo: 100, depreciationPct: 50 },
          ],
        },
        claim: {
          type: "theft",
          estimatedLoss: 3_000,
          itemAge: 8,
        },
        evidence: ["police-report-003"],
      }),
      FakeModelPort.textResponse("Claim with depreciation assessed."),
    ]),
    outcomeChecks: [
      { type: "field_truthy", path: "decision" },
      // payout must be less than estimated loss due to depreciation
      { type: "field_lt", path: "payout", value: 3_000 },
      { type: "field_gt", path: "depreciation", value: 0 },
      { type: "array_min_length", path: "reasons", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "assessClaim" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },

  {
    id: "n5-underinsurance",
    tool: "assessClaim",
    description: "Estimated loss exceeds sum insured — underinsuranceFactor < 1 applied",
    task: {
      id: "eval-n5-underins",
      goal: "Assess this underinsured property claim.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("assessClaim", {
        policy: {
          sumInsured: 40_000,
          deductible: 1_000,
          deductibleType: "integral",
          limits: [],
          depreciationTable: [{ ageYearsFrom: 0, ageYearsTo: 100, depreciationPct: 0 }],
        },
        claim: {
          type: "water",
          estimatedLoss: 60_000, // exceeds sumInsured by 50%
          itemAge: 0,
        },
        evidence: ["adjuster-report-004"],
      }),
      FakeModelPort.textResponse("Underinsurance case assessed."),
    ]),
    outcomeChecks: [
      { type: "field_truthy", path: "decision" },
      // underinsuranceFactor must be strictly less than 1
      { type: "field_lt", path: "underinsuranceFactor", value: 1 },
      { type: "field_gt", path: "underinsuranceFactor", value: 0 },
      { type: "array_min_length", path: "reasons", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "assessClaim" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },
];
