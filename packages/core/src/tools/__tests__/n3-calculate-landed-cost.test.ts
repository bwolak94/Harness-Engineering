import type { CalculateLandedCostInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createCalculateLandedCostTool } from "../n3-calculate-landed-cost.js";

const DEF = {
  name: "calculateLandedCost",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createCalculateLandedCostTool(DEF);

const BASE_INPUT: CalculateLandedCostInput = {
  hsCode: "8501", // Electrical machinery (chapter 85)
  originCountry: "CN",
  destCountry: "PL",
  incoterm: "FOB",
  value: 10_000,
  currency: "EUR",
  weightKg: 100,
  freightCost: 500,
  preferentialOrigin: false,
};

describe("calculateLandedCost", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(typeof out.duty).toBe("number");
    expect(typeof out.vat).toBe("number");
    expect(typeof out.excise).toBe("number");
    expect(typeof out.freight).toBe("number");
    expect(typeof out.total).toBe("number");
    expect(typeof out.effectiveRate).toBe("number");
    expect(Array.isArray(out.appliedRules)).toBe(true);
    expect(out.appliedRules.length).toBeGreaterThan(0);
  });

  it("applies standard duty rate for chapter 85 (2.5%)", async () => {
    const out = await tool.execute(BASE_INPUT);
    // FOB incoterm: customsValue = value + freight = 10500
    const customsValue = BASE_INPUT.value + BASE_INPUT.freightCost;
    const expectedDuty = customsValue * 0.025;
    expect(out.duty).toBeCloseTo(expectedDuty, 2);
  });

  it("VAT calculated on customs value + duty + excise (PL = 23%)", async () => {
    const out = await tool.execute(BASE_INPUT);
    const customsValue = BASE_INPUT.value + BASE_INPUT.freightCost; // 10500
    const duty = customsValue * 0.025;
    const vatBase = customsValue + duty;
    const expectedVat = vatBase * 0.23;
    expect(out.vat).toBeCloseTo(expectedVat, 2);
  });

  it("total = duty + vat + excise + freight", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.total).toBeCloseTo(out.duty + out.vat + out.excise + out.freight, 2);
  });

  it("CIF incoterm: freight not added to customs value", async () => {
    const cifInput: CalculateLandedCostInput = { ...BASE_INPUT, incoterm: "CIF" };
    const fobOut = await tool.execute(BASE_INPUT);
    const cifOut = await tool.execute(cifInput);
    // CIF: customsValue = 10000 (no freight added), FOB: customsValue = 10500
    // So CIF duty should be lower
    expect(cifOut.duty).toBeLessThan(fobOut.duty);
    // But total landed cost of CIF still includes freight (same freightCost)
    // CIF freight passed through: out.freight = freightCost in both cases
    expect(cifOut.freight).toBe(BASE_INPUT.freightCost);
  });

  it("preferential origin reduces duty when preferential rate < standard rate", async () => {
    // Chapter 22 (beverages): standard 9.6%, preferential 3.2%
    const beverageInput: CalculateLandedCostInput = {
      ...BASE_INPUT,
      hsCode: "2201",
      preferentialOrigin: true,
    };
    const nonPrefOut = await tool.execute({ ...beverageInput, preferentialOrigin: false });
    const prefOut = await tool.execute(beverageInput);
    expect(prefOut.duty).toBeLessThan(nonPrefOut.duty);
  });

  it("excise applied for chapter 22 (beverages, 4%)", async () => {
    const beverageInput: CalculateLandedCostInput = { ...BASE_INPUT, hsCode: "2200" };
    const out = await tool.execute(beverageInput);
    expect(out.excise).toBeGreaterThan(0);
  });

  it("no excise for chapter 85 (electrical machinery)", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.excise).toBe(0);
  });

  it("appliedRules lists the HS chapter matched", async () => {
    const out = await tool.execute(BASE_INPUT);
    const ruleText = out.appliedRules.join(" ");
    expect(ruleText).toContain("85");
  });

  it("effectiveRate = duty / declared value × 100", async () => {
    const out = await tool.execute(BASE_INPUT);
    const expectedRate = (out.duty / BASE_INPUT.value) * 100;
    expect(out.effectiveRate).toBeCloseTo(expectedRate, 4);
  });

  it("unknown HS code throws with correctable message listing available chapters", async () => {
    const badInput: CalculateLandedCostInput = { ...BASE_INPUT, hsCode: "9999" };
    await expect(tool.execute(badInput)).rejects.toThrow(/not found/);
    await expect(tool.execute(badInput)).rejects.toThrow(/Available chapters/);
    // Message must include at least one known chapter so the model can self-correct
    await expect(tool.execute(badInput)).rejects.toThrow(/01|84|85/);
  });

  it("unknown destination country: VAT = 0 with correctable message in appliedRules", async () => {
    const unknownDestInput: CalculateLandedCostInput = { ...BASE_INPUT, destCountry: "ZZ" };
    const out = await tool.execute(unknownDestInput);
    expect(out.vat).toBe(0);
    const hasVatNote = out.appliedRules.some((r) => r.includes("ZZ") && r.includes("not in table"));
    expect(hasVatNote).toBe(true);
  });

  it("idempotent: same input produces identical output", async () => {
    const out1 = await tool.execute(BASE_INPUT);
    const out2 = await tool.execute(BASE_INPUT);
    expect(out1).toEqual(out2);
  });
});
