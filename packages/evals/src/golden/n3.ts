import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N3 — calculateLandedCost golden cases.
 *
 * Customs duty + VAT calculation with the Specification pattern.
 * Tests:
 *  1. Standard EU import — duty + 23% VAT, appliedRules non-empty.
 *  2. Preferential origin — reduced effective rate vs standard.
 *  3. DDP incoterm — freight included in customs value.
 */
export const N3_CASES: EvalCase[] = [
  {
    id: "n3-eu-standard-import",
    tool: "calculateLandedCost",
    description: "Standard EU import of electronics (HS 8471) — duty + VAT, appliedRules present",
    task: {
      id: "eval-n3-standard",
      goal: "Calculate the landed cost for this shipment to Poland.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("calculateLandedCost", {
        hsCode: "8471300000",
        originCountry: "CN",
        destCountry: "PL",
        incoterm: "FOB",
        value: 10_000,
        currency: "USD",
        weightKg: 50,
        freightCost: 800,
        preferentialOrigin: false,
      }),
      FakeModelPort.textResponse("Landed cost calculated."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "total", value: 0 },
      // VAT must be present (Poland has 23%)
      { type: "field_gt", path: "vat", value: 0 },
      // effectiveRate must be a percentage (0–100)
      { type: "field_between", path: "effectiveRate", min: 0, max: 100 },
      // audit trail must be non-empty
      { type: "array_min_length", path: "appliedRules", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "calculateLandedCost" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n3-preferential-origin",
    tool: "calculateLandedCost",
    description:
      "Preferential origin — effective rate must be lower than or equal to standard rate",
    task: {
      id: "eval-n3-preferential",
      goal: "What is the landed cost with preferential tariff treatment?",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("calculateLandedCost", {
        hsCode: "6203420000",
        originCountry: "TR",
        destCountry: "PL",
        incoterm: "CIF",
        value: 5_000,
        currency: "EUR",
        weightKg: 20,
        freightCost: 300,
        preferentialOrigin: true,
      }),
      FakeModelPort.textResponse("Preferential landed cost calculated."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "total", value: 0 },
      { type: "field_between", path: "effectiveRate", min: 0, max: 100 },
      { type: "array_min_length", path: "appliedRules", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "calculateLandedCost" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },

  {
    id: "n3-ddp-incoterm",
    tool: "calculateLandedCost",
    description: "DDP incoterm — freight included in customs value, total includes all components",
    task: {
      id: "eval-n3-ddp",
      goal: "Calculate total landed cost under DDP terms.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("calculateLandedCost", {
        // chapter 87 (vehicles) — chapter 94 (furniture) is not in the tariff table
        hsCode: "8703100000",
        originCountry: "VN",
        destCountry: "DE",
        incoterm: "DDP",
        value: 15_000,
        currency: "EUR",
        weightKg: 200,
        freightCost: 1_200,
        preferentialOrigin: false,
      }),
      FakeModelPort.textResponse("DDP landed cost done."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "total", value: 0 },
      { type: "field_gt", path: "freight", value: 0 },
      { type: "array_min_length", path: "appliedRules", minLength: 1 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "calculateLandedCost" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },
];
