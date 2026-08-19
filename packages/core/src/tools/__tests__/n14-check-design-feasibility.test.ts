import type { CheckDesignFeasibilityInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createCheckDesignFeasibilityTool } from "../n14-check-design-feasibility.js";

const DEF = {
  name: "checkDesignFeasibility",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createCheckDesignFeasibilityTool(DEF);

// A fully compliant design to use as a baseline
const GOOD_INPUT: CheckDesignFeasibilityInput = {
  requirements: {
    maxWeightGrams: 200,
    maxLengthMm: 130,
    maxWidthMm: 80,
    maxHeightMm: 25,
    ipRating: "IP54",
    operatingTempMinC: -20,
    operatingTempMaxC: 60,
    targetUnitCostUsd: 20,
    requiredCertifications: ["CE"],
  },
  design: {
    estimatedWeightGrams: 180,
    lengthMm: 120,
    widthMm: 70,
    heightMm: 20,
    materials: [
      {
        name: "ABS housing",
        ipRatingCapable: "IP55",
        tempMinC: -30,
        tempMaxC: 80,
      },
    ],
    estimatedUnitCostUsd: 18,
    certificationStatus: { CE: "certified" },
  },
};

describe("N14 checkDesignFeasibility", () => {
  it("returns score 1 and no violations for a fully compliant design", async () => {
    const result = await tool.execute(GOOD_INPUT);

    expect(result.feasibilityScore).toBe(1);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("hard violation when weight exceeds limit by more than 20%", async () => {
    const result = await tool.execute({
      ...GOOD_INPUT,
      design: { ...GOOD_INPUT.design, estimatedWeightGrams: 260 }, // 30% over 200
    });

    const weightViolation = result.violations.find((v) => v.constraint === "maxWeightGrams");
    expect(weightViolation).toBeDefined();
    expect(weightViolation?.severity).toBe("hard");
    expect(result.feasibilityScore).toBeLessThan(1);
    expect(result.recommendations.some((r) => r.toLowerCase().includes("weight"))).toBe(true);
  });

  it("soft violation when weight is 5–20% over limit", async () => {
    const result = await tool.execute({
      ...GOOD_INPUT,
      design: { ...GOOD_INPUT.design, estimatedWeightGrams: 215 }, // 7.5% over 200
    });

    const weightViolation = result.violations.find((v) => v.constraint === "maxWeightGrams");
    expect(weightViolation?.severity).toBe("soft");
  });

  it("hard violation when a dimension exceeds limit", async () => {
    const result = await tool.execute({
      ...GOOD_INPUT,
      design: { ...GOOD_INPUT.design, lengthMm: 145 }, // 145 > 130
    });

    const dimViolation = result.violations.find((v) => v.constraint === "maxLengthMm");
    expect(dimViolation).toBeDefined();
    expect(dimViolation?.severity).toBe("hard");
  });

  it("hard violation when design IP rating is insufficient", async () => {
    const result = await tool.execute({
      requirements: { ...GOOD_INPUT.requirements, ipRating: "IP67" },
      design: {
        ...GOOD_INPUT.design,
        materials: [{ name: "ABS housing", ipRatingCapable: "IP54", tempMinC: -30, tempMaxC: 80 }],
      },
    });

    const ipViolation = result.violations.find((v) => v.constraint === "ipRating");
    expect(ipViolation).toBeDefined();
    expect(ipViolation?.severity).toBe("hard");
    expect(result.recommendations.some((r) => r.toLowerCase().includes("water"))).toBe(true);
  });

  it("hard violation when material temp range excludes required minimum", async () => {
    const result = await tool.execute({
      requirements: { ...GOOD_INPUT.requirements, operatingTempMinC: -30 },
      design: {
        ...GOOD_INPUT.design,
        materials: [
          {
            name: "Standard ABS",
            ipRatingCapable: "IP55",
            tempMinC: -10, // insufficient
            tempMaxC: 80,
          },
        ],
      },
    });

    const tempViolation = result.violations.find((v) => v.constraint === "operatingTempMinC");
    expect(tempViolation).toBeDefined();
    expect(tempViolation?.severity).toBe("hard");
  });

  it("soft violation when estimated cost exceeds target by more than 10%", async () => {
    const result = await tool.execute({
      ...GOOD_INPUT,
      design: { ...GOOD_INPUT.design, estimatedUnitCostUsd: 23 }, // 15% over $20
    });

    const costViolation = result.violations.find((v) => v.constraint === "targetUnitCostUsd");
    expect(costViolation?.severity).toBe("soft");
  });

  it("hard violation when drop test height is insufficient", async () => {
    const result = await tool.execute({
      requirements: { ...GOOD_INPUT.requirements, dropTestHeightM: 1.8 },
      design: { ...GOOD_INPUT.design, dropTestHeightM: 1.0 },
    });

    const dropViolation = result.violations.find((v) => v.constraint === "dropTestHeightM");
    expect(dropViolation?.severity).toBe("hard");
  });

  it("warns for certification that is only planned", async () => {
    const result = await tool.execute({
      ...GOOD_INPUT,
      requirements: { ...GOOD_INPUT.requirements, requiredCertifications: ["CE", "FCC"] },
      design: {
        ...GOOD_INPUT.design,
        certificationStatus: { CE: "certified", FCC: "planned" },
      },
    });

    expect(result.warnings.some((w) => w.includes("FCC"))).toBe(true);
  });

  it("hard violation and score < 1 when no materials have IP rating data", async () => {
    const result = await tool.execute({
      requirements: { ...GOOD_INPUT.requirements, ipRating: "IP67" },
      design: {
        ...GOOD_INPUT.design,
        materials: [{ name: "Unknown material" }],
      },
    });

    const ipViolation = result.violations.find((v) => v.constraint === "ipRating");
    expect(ipViolation?.severity).toBe("hard");
    expect(result.feasibilityScore).toBeLessThan(1);
  });

  it("computes composite IP from multiple materials using worst-case axis", async () => {
    // Material A: IP65 (dust=6, water=5), Material B: IP56 (dust=5, water=6)
    // Composite: min(6,5) = 5 for dust, min(5,6) = 5 for water → IP55
    // Requirement: IP54 → should pass (IP55 ≥ IP54)
    const result = await tool.execute({
      requirements: { ...GOOD_INPUT.requirements, ipRating: "IP54" },
      design: {
        ...GOOD_INPUT.design,
        materials: [
          { name: "Shell", ipRatingCapable: "IP65" },
          { name: "Gasket", ipRatingCapable: "IP56" },
        ],
      },
    });

    const ipViolation = result.violations.find((v) => v.constraint === "ipRating");
    expect(ipViolation).toBeUndefined();
  });

  it("summary mentions hard violations count when failures exist", async () => {
    const result = await tool.execute({
      ...GOOD_INPUT,
      design: { ...GOOD_INPUT.design, estimatedWeightGrams: 400 }, // hard weight fail
    });

    expect(result.summary).toMatch(/hard violation/i);
  });

  it("no violation when requirements object has no constraints", async () => {
    const result = await tool.execute({
      requirements: { requiredCertifications: [] },
      design: {
        estimatedWeightGrams: 500,
        lengthMm: 300,
        widthMm: 200,
        heightMm: 100,
        materials: [{ name: "Steel" }],
        certificationStatus: {},
      },
    });

    expect(result.violations).toHaveLength(0);
    expect(result.feasibilityScore).toBe(1);
  });
});
