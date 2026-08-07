import type { CalculateNetSalaryInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createCalculateNetSalaryTool } from "../n9-calculate-net-salary.js";

const DEF = {
  name: "calculateNetSalary",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createCalculateNetSalaryTool(DEF);

const BASE_UOP: CalculateNetSalaryInput = {
  gross: 10_000,
  contractType: "uop",
  year: 2024,
  taxReliefs: [],
  ppkRate: 2,
  jointFiling: false,
};

describe("calculateNetSalary — UoP", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_UOP);
    expect(typeof out.net).toBe("number");
    expect(typeof out.zusEmployee).toBe("number");
    expect(typeof out.zusEmployer).toBe("number");
    expect(typeof out.health).toBe("number");
    expect(typeof out.deductibleCosts).toBe("number");
    expect(typeof out.advanceTax).toBe("number");
    expect(typeof out.employerTotalCost).toBe("number");
    expect(Array.isArray(out.appliedThresholds)).toBe(true);
  });

  it("net < gross (deductions applied)", async () => {
    const out = await tool.execute(BASE_UOP);
    expect(out.net).toBeLessThan(BASE_UOP.gross);
  });

  it("employer total cost > gross (employer ZUS + PPK on top)", async () => {
    const out = await tool.execute(BASE_UOP);
    expect(out.employerTotalCost).toBeGreaterThan(BASE_UOP.gross);
  });

  it("ZUS employee ≈ 13.71% of gross (pension 9.76 + disability 1.5 + sickness 2.45)", async () => {
    const out = await tool.execute(BASE_UOP);
    const expectedZus = BASE_UOP.gross * (0.0976 + 0.015 + 0.0245);
    expect(out.zusEmployee).toBeCloseTo(expectedZus, 2);
  });

  it("PPK opted out: no PPK deduction from net", async () => {
    const noPpk: CalculateNetSalaryInput = { ...BASE_UOP, ppkRate: 0 };
    const withPpk = await tool.execute(BASE_UOP);
    const withoutPpk = await tool.execute(noPpk);
    // ppkEmployee = 10000 * 2% = 200
    expect(withPpk.net).toBeCloseTo(withoutPpk.net - 200, 1);
  });

  it("young_person_zero_tax relief zeroes the advance tax", async () => {
    const youngInput: CalculateNetSalaryInput = {
      ...BASE_UOP,
      taxReliefs: [{ type: "young_person_zero_tax" }],
    };
    const out = await tool.execute(youngInput);
    expect(out.advanceTax).toBe(0);
  });

  it("child_relief reduces advance tax by monthlyAmount", async () => {
    const baseOut = await tool.execute(BASE_UOP);
    const childInput: CalculateNetSalaryInput = {
      ...BASE_UOP,
      taxReliefs: [{ type: "child_relief", monthlyAmount: 200 }],
    };
    const childOut = await tool.execute(childInput);
    expect(childOut.advanceTax).toBeCloseTo(Math.max(0, baseOut.advanceTax - 200), 1);
  });

  it("jointFiling reduces advance tax (lower effective rate)", async () => {
    const jointInput: CalculateNetSalaryInput = { ...BASE_UOP, jointFiling: true };
    const soloOut = await tool.execute(BASE_UOP);
    const jointOut = await tool.execute(jointInput);
    // With joint filing (halved base, so lower bracket), tax should be ≤ solo
    expect(jointOut.advanceTax).toBeLessThanOrEqual(soloOut.advanceTax);
  });

  it("appliedThresholds records the year and rate", async () => {
    const out = await tool.execute(BASE_UOP);
    const thresholds = out.appliedThresholds.join(" ");
    expect(thresholds).toContain("2024");
  });

  it("idempotent: same input produces identical output", async () => {
    const out1 = await tool.execute(BASE_UOP);
    const out2 = await tool.execute(BASE_UOP);
    expect(out1).toEqual(out2);
  });
});

describe("calculateNetSalary — zlecenie", () => {
  it("deductible costs = 20% of gross (not fixed 250 PLN)", async () => {
    const zlecenieInput: CalculateNetSalaryInput = { ...BASE_UOP, contractType: "zlecenie" };
    const out = await tool.execute(zlecenieInput);
    expect(out.deductibleCosts).toBeCloseTo(BASE_UOP.gross * 0.2, 2);
  });
});

describe("calculateNetSalary — b2b", () => {
  it("returns valid output for b2b contract type", async () => {
    const b2bInput: CalculateNetSalaryInput = { ...BASE_UOP, contractType: "b2b" };
    const out = await tool.execute(b2bInput);
    expect(out.net).toBeGreaterThan(0);
    expect(out.net).toBeLessThan(BASE_UOP.gross);
  });
});

describe("calculateNetSalary — unknown year", () => {
  it("throws with correctable message for unsupported year", async () => {
    const futureInput: CalculateNetSalaryInput = { ...BASE_UOP, year: 2030 };
    await expect(tool.execute(futureInput)).rejects.toThrow(/2030/);
    await expect(tool.execute(futureInput)).rejects.toThrow(/Available years/);
  });
});
