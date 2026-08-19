import { describe, expect, it } from "vitest";
import { createEstimateProductWeightTool } from "../n15-estimate-product-weight.js";

const DEF = {
  name: "estimateProductWeight",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createEstimateProductWeightTool(DEF);

const STANDARD_COMPONENTS = [
  { id: "pcb", name: "Main PCB", quantity: 1, massGrams: 25, category: "pcb" as const },
  { id: "enc", name: "Enclosure", quantity: 1, massGrams: 60, category: "structural" as const },
  { id: "bat", name: "Battery", quantity: 1, massGrams: 35, category: "battery" as const },
  { id: "screw", name: "M3 Screw", quantity: 4, massGrams: 1.5, category: "fastener" as const },
];

describe("N15 estimateProductWeight", () => {
  it("computes total product weight correctly", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
    });

    // 25 + 60 + 35 + (4 × 1.5) = 126
    expect(result.totalProductWeightGrams).toBe(126);
  });

  it("adds packaging mass to get shipping weight", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 80,
    });

    expect(result.packagingWeightGrams).toBe(80);
    expect(result.shippingWeightGrams).toBe(206); // 126 + 80
  });

  it("marks targetMet = true when under budget", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
      targetMaxWeightGrams: 150,
    });

    expect(result.targetMet).toBe(true);
    expect(result.overageGrams).toBeLessThanOrEqual(0);
  });

  it("marks targetMet = false and reports overage when over budget", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
      targetMaxWeightGrams: 100,
    });

    expect(result.targetMet).toBe(false);
    expect(result.overageGrams).toBeCloseTo(26, 1); // 126 - 100
  });

  it("targetMet is null when no target provided", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
    });

    expect(result.targetMet).toBeNull();
    expect(result.overageGrams).toBeNull();
  });

  it("component breakdown is sorted descending by total mass", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
    });

    const masses = result.componentBreakdown.map((r) => r.totalMassGrams);
    for (let i = 1; i < masses.length; i++) {
      expect(masses[i]).toBeLessThanOrEqual(masses[i - 1] as number);
    }
  });

  it("heaviest components lists up to 5 names, sorted by total mass", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
    });

    expect(result.heaviestComponents.length).toBeLessThanOrEqual(5);
    // First heaviest should be the enclosure (60 g)
    expect(result.heaviestComponents[0]).toBe("Enclosure");
  });

  it("computes correct percent of total per component", async () => {
    const result = await tool.execute({
      components: [
        { id: "a", name: "A", quantity: 1, massGrams: 75, category: "structural" as const },
        { id: "b", name: "B", quantity: 1, massGrams: 25, category: "other" as const },
      ],
      packagingMassGrams: 0,
    });

    const rowA = result.componentBreakdown.find((r) => r.id === "a");
    const rowB = result.componentBreakdown.find((r) => r.id === "b");

    expect(rowA?.percentOfProductWeight).toBeCloseTo(75, 1);
    expect(rowB?.percentOfProductWeight).toBeCloseTo(25, 1);
  });

  it("aggregates category breakdown correctly", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 0,
    });

    const structural = result.categoryBreakdown.find((c) => c.category === "structural");
    const fastener = result.categoryBreakdown.find((c) => c.category === "fastener");

    expect(structural?.totalMassGrams).toBe(60);
    expect(fastener?.totalMassGrams).toBe(6); // 4 × 1.5
    expect(fastener?.componentCount).toBe(1);
  });

  it("accounts for quantity correctly in total mass calculation", async () => {
    const result = await tool.execute({
      components: [
        { id: "bolt", name: "Bolt", quantity: 8, massGrams: 2.5, category: "fastener" as const },
      ],
      packagingMassGrams: 0,
    });

    expect(result.totalProductWeightGrams).toBe(20); // 8 × 2.5
    expect(result.componentBreakdown[0]?.totalMassGrams).toBe(20);
    expect(result.componentBreakdown[0]?.unitMassGrams).toBe(2.5);
  });

  it("includes non-empty assumptions array", async () => {
    const result = await tool.execute({
      components: STANDARD_COMPONENTS,
      packagingMassGrams: 50,
      targetMaxWeightGrams: 130,
    });

    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.assumptions.some((a) => a.includes("126"))).toBe(true);
  });
});
