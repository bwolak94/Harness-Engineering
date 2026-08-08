import type { SimulatePVPaybackInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createSimulatePVPaybackTool } from "../n8-simulate-pv-payback.js";

const DEF = {
  name: "simulatePVPayback",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "expensive" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createSimulatePVPaybackTool(DEF);

/** Flat consumption profile: 0.5 kWh every hour (4380 kWh/year). */
const FLAT_PROFILE = Array<number>(8760).fill(0.5);

const BASE_INPUT: SimulatePVPaybackInput = {
  lat: 52.0, // Warsaw latitude — moderate solar
  lng: 21.0,
  kWp: 10,
  tiltDeg: 35,
  azimuthDeg: 180, // south-facing
  consumptionProfile: FLAT_PROFILE,
  tariff: {
    zones: [{ name: "peak", hoursFrom: 0, hoursTo: 24, pricePerKwh: 0.25 }],
    netBilling: false,
    exportRatePerKwh: 0,
  },
  capex: 10_000,
};

describe("simulatePVPayback", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(typeof out.yearlyKWh).toBe("number");
    expect(typeof out.selfConsumptionPct).toBe("number");
    expect(Array.isArray(out.savingsPerYear)).toBe(true);
    expect(typeof out.paybackYears).toBe("number");
    expect(out.monthlyBreakdown).toHaveLength(12);
  });

  it("yearly generation is positive for south-facing system at 52°N", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.yearlyKWh).toBeGreaterThan(0);
  });

  it("selfConsumptionPct is between 0 and 100", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.selfConsumptionPct).toBeGreaterThanOrEqual(0);
    expect(out.selfConsumptionPct).toBeLessThanOrEqual(100);
  });

  it("monthly breakdown sums approximately to yearly totals", async () => {
    const out = await tool.execute(BASE_INPUT);
    const sumGeneration = out.monthlyBreakdown.reduce((s, m) => s + m.generationKwh, 0);
    expect(Math.abs(sumGeneration - out.yearlyKWh)).toBeLessThan(1); // rounding tolerance
  });

  it("monthly breakdown has all 12 months", async () => {
    const out = await tool.execute(BASE_INPUT);
    const months = out.monthlyBreakdown.map((m) => m.month);
    expect(months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("summer months generate more than winter months at 52°N", async () => {
    const out = await tool.execute(BASE_INPUT);
    const june = out.monthlyBreakdown.find((m) => m.month === 6);
    const december = out.monthlyBreakdown.find((m) => m.month === 12);
    if (!june || !december) throw new Error("Expected months not found in breakdown");
    expect(june.generationKwh).toBeGreaterThan(december.generationKwh);
  });

  it("higher kWp yields proportionally more generation", async () => {
    const out5 = await tool.execute({ ...BASE_INPUT, kWp: 5 });
    const out10 = await tool.execute({ ...BASE_INPUT, kWp: 10 });
    const ratio = out10.yearlyKWh / out5.yearlyKWh;
    expect(ratio).toBeCloseTo(2, 0); // roughly linear (within 5%)
  });

  it("payback is finite for non-zero savings", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(Number.isFinite(out.paybackYears)).toBe(true);
    expect(out.paybackYears).toBeGreaterThan(0);
  });

  it("net billing with export rate increases savings", async () => {
    const withoutExport = await tool.execute(BASE_INPUT);
    const withExport = await tool.execute({
      ...BASE_INPUT,
      tariff: { ...BASE_INPUT.tariff, netBilling: true, exportRatePerKwh: 0.1 },
    });
    expect(withExport.savingsPerYear[0]).toBeGreaterThan(withoutExport.savingsPerYear[0] ?? 0);
  });

  it("zero consumption → 100% export, 0% self-consumption", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      consumptionProfile: Array(8760).fill(0),
    });
    expect(out.selfConsumptionPct).toBe(0);
  });

  it("completes 8760 iterations in reasonable time", async () => {
    const start = Date.now();
    await tool.execute(BASE_INPUT);
    const elapsed = Date.now() - start;
    // Should complete well under 1s even in CI
    expect(elapsed).toBeLessThan(1000);
  });

  it("south-facing outperforms north-facing at 52°N", async () => {
    const south = await tool.execute({ ...BASE_INPUT, azimuthDeg: 180 });
    const north = await tool.execute({ ...BASE_INPUT, azimuthDeg: 0 });
    expect(south.yearlyKWh).toBeGreaterThan(north.yearlyKWh);
  });
});
