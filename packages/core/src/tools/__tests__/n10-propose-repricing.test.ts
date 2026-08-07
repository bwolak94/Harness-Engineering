import type { ProposeRepricingInput } from "@harness/contracts/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProposeRepricingTool } from "../n10-propose-repricing.js";

const DEF = {
  name: "proposeRepricing",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "cheap" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createProposeRepricingTool(DEF);

/** Returns an ISO 8601 timestamp `hoursAgo` hours before now. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const BASE_INPUT: ProposeRepricingInput = {
  products: [{ sku: "A", cost: 50, currentPrice: 100, lastChangeAt: hoursAgo(48) }],
  competitorPrices: [{ sku: "A", competitorId: "C1", price: 95, capturedAt: hoursAgo(1) }],
  minMarginPct: 20,
  elasticity: -2,
  cooldownHours: 24,
  maxDailyChangePct: 10,
};

describe("proposeRepricing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns proposed and blocked arrays", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(Array.isArray(out.proposed)).toBe(true);
    expect(Array.isArray(out.blocked)).toBe(true);
  });

  it("proposes a new price when cooldown has passed", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.proposed.length).toBe(1);
    expect(out.proposed[0]?.sku).toBe("A");
    expect(out.blocked.length).toBe(0);
  });

  it("blocks SKU still in cooldown window", async () => {
    const cooldownInput: ProposeRepricingInput = {
      ...BASE_INPUT,
      products: [{ sku: "A", cost: 50, currentPrice: 100, lastChangeAt: hoursAgo(1) }],
      cooldownHours: 24,
    };
    const out = await tool.execute(cooldownInput);
    expect(out.blocked.length).toBe(1);
    expect(out.blocked[0]?.sku).toBe("A");
    expect(out.blocked[0]?.reason).toContain("Cooldown");
    expect(out.proposed.length).toBe(0);
  });

  it("respects margin floor — price never below cost/(1-minMarginPct/100)", async () => {
    const out = await tool.execute(BASE_INPUT);
    for (const p of out.proposed) {
      // Find cost for sku
      const product = BASE_INPUT.products.find((pr) => pr.sku === p.sku);
      if (!product) continue;
      const minPrice = product.cost / (1 - BASE_INPUT.minMarginPct / 100);
      expect(p.newPrice).toBeGreaterThanOrEqual(minPrice - 0.01);
    }
  });

  it("blocks when margin floor cannot be satisfied within maxDailyChangePct", async () => {
    const impossibleInput: ProposeRepricingInput = {
      ...BASE_INPUT,
      products: [{ sku: "A", cost: 99, currentPrice: 100, lastChangeAt: hoursAgo(48) }],
      minMarginPct: 50, // floor = 99/(1-0.5) = 198, but daily cap = 100 * 1.1 = 110
      maxDailyChangePct: 10,
    };
    const out = await tool.execute(impossibleInput);
    expect(out.blocked.length).toBe(1);
    expect(out.blocked[0]?.sku).toBe("A");
  });

  it("clamps price to maxDailyChangePct upper bound", async () => {
    // No competitors, elasticity suggests high price
    const highElasticityInput: ProposeRepricingInput = {
      ...BASE_INPUT,
      products: [{ sku: "A", cost: 10, currentPrice: 100, lastChangeAt: hoursAgo(48) }],
      competitorPrices: [],
      elasticity: -1.1, // weakly elastic: elasticity price = 10 * 1.1 / 0.1 = 110
      maxDailyChangePct: 5,
    };
    const out = await tool.execute(highElasticityInput);
    if (out.proposed.length > 0) {
      const newPrice = out.proposed[0]?.newPrice ?? 0;
      expect(newPrice).toBeLessThanOrEqual(100 * 1.05 + 0.01); // currentPrice + 5%
    }
  });

  it("handles multiple SKUs independently", async () => {
    const multiInput: ProposeRepricingInput = {
      ...BASE_INPUT,
      products: [
        { sku: "X", cost: 50, currentPrice: 100, lastChangeAt: hoursAgo(48) },
        { sku: "Y", cost: 50, currentPrice: 100, lastChangeAt: hoursAgo(1) }, // in cooldown
      ],
      competitorPrices: [],
    };
    const out = await tool.execute(multiInput);
    const proposedSkus = out.proposed.map((p) => p.sku);
    const blockedSkus = out.blocked.map((b) => b.sku);
    expect(proposedSkus).toContain("X");
    expect(blockedSkus).toContain("Y");
  });

  it("rationale field is non-empty string", async () => {
    const out = await tool.execute(BASE_INPUT);
    for (const p of out.proposed) {
      expect(typeof p.rationale).toBe("string");
      expect(p.rationale.length).toBeGreaterThan(0);
    }
  });

  it("expectedMarginPct reflects (newPrice − cost) / newPrice × 100", async () => {
    const out = await tool.execute(BASE_INPUT);
    for (const p of out.proposed) {
      const product = BASE_INPUT.products.find((pr) => pr.sku === p.sku);
      if (!product) continue;
      const expectedMargin = ((p.newPrice - product.cost) / p.newPrice) * 100;
      expect(p.expectedMarginPct).toBeCloseTo(expectedMargin, 0);
    }
  });

  it("idempotent: two calls with same (fixed) lastChangeAt produce same output", async () => {
    const fixedInput: ProposeRepricingInput = {
      ...BASE_INPUT,
      products: [
        // Use a timestamp 1000 years in the past so cooldown can never affect it
        { sku: "A", cost: 50, currentPrice: 100, lastChangeAt: "2000-01-01T00:00:00.000Z" },
      ],
    };
    const out1 = await tool.execute(fixedInput);
    const out2 = await tool.execute(fixedInput);
    expect(out1.proposed).toEqual(out2.proposed);
    expect(out1.blocked).toEqual(out2.blocked);
  });
});
