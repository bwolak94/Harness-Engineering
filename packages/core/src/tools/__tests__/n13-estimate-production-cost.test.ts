import { describe, expect, it } from "vitest";
import { createEstimateProductionCostTool } from "../n13-estimate-production-cost.js";

const DEF = {
  name: "estimateProductionCost",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createEstimateProductionCostTool(DEF);

// Minimal BOM used across multiple tests
const BOM_SIMPLE = [
  {
    id: "mcu",
    name: "MCU",
    quantity: 1,
    unitCostBase: 4.0,
    volumeDiscounts: [{ minQty: 1000, discountPct: 10 }],
  },
  {
    id: "enc",
    name: "Enclosure",
    quantity: 1,
    unitCostBase: 3.0,
    volumeDiscounts: [],
  },
];

describe("N13 estimateProductionCost", () => {
  it("computes correct material cost at low volume (no discounts applied)", async () => {
    const result = await tool.execute({
      bom: BOM_SIMPLE,
      labor: { hoursPerUnit: 0.25, hourlyRate: 20 },
      overheadPct: 30,
      toolingFixedCost: 0,
      productionVolumes: [100],
    });

    const row = result.volumeBreakdown[0];
    expect(row).toBeDefined();
    // material: 4.0 + 3.0 = 7.0
    expect(row?.materialCostPerUnit).toBeCloseTo(7.0, 4);
    // labour: 0.25 × 20 = 5.0
    expect(row?.laborCostPerUnit).toBeCloseTo(5.0, 4);
    // overhead: (7.0 + 5.0) × 0.30 = 3.6
    expect(row?.overheadCostPerUnit).toBeCloseTo(3.6, 4);
    // tooling: 0
    expect(row?.toolingAmortizedPerUnit).toBe(0);
    // total: 7 + 5 + 3.6 = 15.6
    expect(row?.unitCostTotal).toBeCloseTo(15.6, 4);
  });

  it("applies volume discount when order quantity reaches bracket", async () => {
    const result = await tool.execute({
      bom: BOM_SIMPLE,
      labor: { hoursPerUnit: 0.0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 0,
      productionVolumes: [2000], // qty × 1 = 2000 ≥ minQty 1000 → 10% discount on MCU
    });

    const row = result.volumeBreakdown[0];
    // MCU after 10% discount: 4.0 × 0.9 = 3.6; Enclosure: 3.0
    expect(row?.materialCostPerUnit).toBeCloseTo(6.6, 4);
  });

  it("amortises tooling cost across production volume", async () => {
    const result = await tool.execute({
      bom: [{ id: "p", name: "Part", quantity: 1, unitCostBase: 1.0, volumeDiscounts: [] }],
      labor: { hoursPerUnit: 0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 10000,
      productionVolumes: [1000, 5000],
    });

    const [row1000, row5000] = result.volumeBreakdown;
    expect(row1000?.toolingAmortizedPerUnit).toBeCloseTo(10, 4); // 10000 / 1000
    expect(row5000?.toolingAmortizedPerUnit).toBeCloseTo(2, 4); // 10000 / 5000
  });

  it("computes gross margin when targetRetailPrice is provided", async () => {
    const result = await tool.execute({
      bom: [{ id: "p", name: "Part", quantity: 1, unitCostBase: 10, volumeDiscounts: [] }],
      labor: { hoursPerUnit: 0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 0,
      productionVolumes: [100],
      targetRetailPrice: 40,
    });

    // unit cost = 10; margin = (40 - 10) / 40 × 100 = 75%
    expect(result.volumeBreakdown[0]?.grossMarginPct).toBeCloseTo(75, 4);
  });

  it("reports minimumViableVolume when 50% margin floor is reached", async () => {
    // At volume 100: tooling = 10000/100 = 100/unit → unitCost = 101 → margin at price 50 is negative
    // At volume 10000: tooling = 10000/10000 = 1/unit → unitCost = 11 → 50% of 50 = 25 → 11 ≤ 25 ✓
    const result = await tool.execute({
      bom: [{ id: "p", name: "Part", quantity: 1, unitCostBase: 10, volumeDiscounts: [] }],
      labor: { hoursPerUnit: 0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 10000,
      productionVolumes: [100, 500, 10000],
      targetRetailPrice: 50,
    });

    expect(result.minimumViableVolume).toBe(10000);
  });

  it("returns rows sorted ascending by volume", async () => {
    const result = await tool.execute({
      bom: [{ id: "p", name: "Part", quantity: 1, unitCostBase: 1, volumeDiscounts: [] }],
      labor: { hoursPerUnit: 0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 0,
      productionVolumes: [5000, 100, 1000],
    });

    const volumes = result.volumeBreakdown.map((r) => r.volume);
    expect(volumes).toEqual([100, 1000, 5000]);
  });

  it("omits grossMarginPct when targetRetailPrice is not provided", async () => {
    const result = await tool.execute({
      bom: [{ id: "p", name: "Part", quantity: 1, unitCostBase: 5, volumeDiscounts: [] }],
      labor: { hoursPerUnit: 0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 0,
      productionVolumes: [1000],
    });

    expect(result.volumeBreakdown[0]?.grossMarginPct).toBeUndefined();
  });

  it("includes assumptions for every volume", async () => {
    const result = await tool.execute({
      bom: BOM_SIMPLE,
      labor: { hoursPerUnit: 0.5, hourlyRate: 15 },
      overheadPct: 20,
      toolingFixedCost: 5000,
      productionVolumes: [200, 2000],
    });

    expect(result.assumptions.length).toBeGreaterThan(0);
    // One assumption per volume breakdown line
    const v200 = result.assumptions.some((a) => a.includes("V=200"));
    const v2000 = result.assumptions.some((a) => a.includes("V=2000"));
    expect(v200).toBe(true);
    expect(v2000).toBe(true);
  });

  it("highest volume discount wins when multiple brackets apply", async () => {
    const result = await tool.execute({
      bom: [
        {
          id: "chip",
          name: "Chip",
          quantity: 1,
          unitCostBase: 10,
          volumeDiscounts: [
            { minQty: 100, discountPct: 5 },
            { minQty: 500, discountPct: 15 },
            { minQty: 1000, discountPct: 25 },
          ],
        },
      ],
      labor: { hoursPerUnit: 0, hourlyRate: 0 },
      overheadPct: 0,
      toolingFixedCost: 0,
      productionVolumes: [1000], // qualifies for all three — should pick 25%
    });

    // 10 × (1 - 0.25) = 7.5
    expect(result.volumeBreakdown[0]?.materialCostPerUnit).toBeCloseTo(7.5, 4);
  });
});
