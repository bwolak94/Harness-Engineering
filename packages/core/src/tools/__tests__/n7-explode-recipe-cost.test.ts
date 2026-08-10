import type { ExplodeRecipeCostInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createExplodeRecipeCostTool } from "../n7-explode-recipe-cost.js";

const DEF = {
  name: "explodeRecipeCost",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createExplodeRecipeCostTool(DEF);

// ---------------------------------------------------------------------------
// Shared price list for tests (leaf ingredient prices)
// ---------------------------------------------------------------------------

const PRICE_LIST: ExplodeRecipeCostInput["priceList"] = [
  { ingredientId: "flour",           pricePerUnit: 0.002,  unit: "g" },    // 2 PLN/kg
  { ingredientId: "water",           pricePerUnit: 0.0002, unit: "ml" },
  { ingredientId: "yeast",           pricePerUnit: 0.1,    unit: "g" },
  { ingredientId: "salt",            pricePerUnit: 0.003,  unit: "g" },
  { ingredientId: "olive-oil",       pricePerUnit: 0.02,   unit: "ml" },
  { ingredientId: "canned-tomatoes", pricePerUnit: 0.005,  unit: "g" },
  { ingredientId: "basil",           pricePerUnit: 0.08,   unit: "g" },
  { ingredientId: "garlic",          pricePerUnit: 0.05,   unit: "g" },
  { ingredientId: "mozzarella",      pricePerUnit: 0.04,   unit: "g" },
  { ingredientId: "mascarpone",      pricePerUnit: 0.03,   unit: "g" },
  { ingredientId: "ladyfingers",     pricePerUnit: 0.025,  unit: "g" },
  { ingredientId: "ground-coffee",   pricePerUnit: 0.05,   unit: "g" },
  { ingredientId: "egg-yolk",        pricePerUnit: 0.5,    unit: "pcs" },
  { ingredientId: "sugar",           pricePerUnit: 0.003,  unit: "g" },
  { ingredientId: "cream",           pricePerUnit: 0.012,  unit: "ml" },
  { ingredientId: "cocoa-powder",    pricePerUnit: 0.025,  unit: "g" },
  { ingredientId: "beef-chuck",      pricePerUnit: 0.06,   unit: "g" },
  { ingredientId: "red-wine",        pricePerUnit: 0.015,  unit: "ml" },
  { ingredientId: "carrots",         pricePerUnit: 0.003,  unit: "g" },
  { ingredientId: "onions",          pricePerUnit: 0.002,  unit: "g" },
  { ingredientId: "butter",          pricePerUnit: 0.02,   unit: "g" },
];

const NO_STOCK: ExplodeRecipeCostInput["stockLevels"] = [];

const BASE_INPUT: ExplodeRecipeCostInput = {
  recipeId: "pizza-margherita",
  portions: 4,
  stockLevels: NO_STOCK,
  priceList: PRICE_LIST,
  maxDepth: 10,
};

describe("explodeRecipeCost", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(typeof out.unitCost).toBe("number");
    expect(typeof out.totalCost).toBe("number");
    expect(typeof out.margin).toBe("number");
    expect(Array.isArray(out.purchaseList)).toBe(true);
    expect(Array.isArray(out.substitutions)).toBe(true);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.bomTree).toBeDefined();
    expect(out.bomTree.ingredientId).toBe("pizza-margherita");
  });

  it("totalCost = unitCost × portions", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.totalCost).toBeCloseTo(out.unitCost * BASE_INPUT.portions, 2);
  });

  it("totalCost is positive when priceList is non-empty", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.totalCost).toBeGreaterThan(0);
  });

  it("purchaseList contains leaf ingredients (not sub-recipes)", async () => {
    const out = await tool.execute(BASE_INPUT);
    // pizza-margherita expands to leaf ingredients: flour, water, yeast, etc.
    // Sub-recipe IDs (pizza-dough, tomato-sauce) should NOT appear in purchaseList
    const ids = out.purchaseList.map((e) => e.ingredientId);
    expect(ids).not.toContain("pizza-dough");
    expect(ids).not.toContain("tomato-sauce");
    // Leaf ingredients must appear
    expect(ids).toContain("flour");
    expect(ids).toContain("mozzarella");
  });

  it("purchaseList toBuy = required when no stock", async () => {
    const out = await tool.execute(BASE_INPUT);
    for (const item of out.purchaseList) {
      expect(item.toBuy).toBeCloseTo(item.required, 3);
      expect(item.onHand).toBe(0);
    }
  });

  it("purchaseList toBuy accounts for stock on hand", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      stockLevels: [{ ingredientId: "flour", quantityOnHand: 100, unit: "g" }],
    });
    const flour = out.purchaseList.find((e) => e.ingredientId === "flour")!;
    expect(flour.onHand).toBe(100);
    expect(flour.toBuy).toBeLessThan(flour.required);
    expect(flour.toBuy).toBeCloseTo(Math.max(0, flour.required - 100), 3);
  });

  it("toBuy is 0 when stock covers the full requirement", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      stockLevels: [{ ingredientId: "flour", quantityOnHand: 10_000, unit: "g" }],
    });
    const flour = out.purchaseList.find((e) => e.ingredientId === "flour")!;
    expect(flour.toBuy).toBe(0);
  });

  it("bomTree recursion: pizza-dough node has children (flour, water, yeast…)", async () => {
    const out = await tool.execute(BASE_INPUT);
    const doughNode = out.bomTree.children.find((c) => c.ingredientId === "pizza-dough");
    expect(doughNode).toBeDefined();
    expect(doughNode!.children.length).toBeGreaterThan(0);
    const childIds = doughNode!.children.map((c) => c.ingredientId);
    expect(childIds).toContain("flour");
    expect(childIds).toContain("water");
  });

  it("scaling: 2 portions costs half of 4 portions", async () => {
    const out4 = await tool.execute(BASE_INPUT);
    const out2 = await tool.execute({ ...BASE_INPUT, portions: 2 });
    expect(out2.totalCost).toBeCloseTo(out4.totalCost / 2, 1);
  });

  it("yieldLossPct increases required mozzarella quantity", async () => {
    const outWith = await tool.execute(BASE_INPUT); // mozzarella has 5% yield loss
    // Gross up: we need more than the net quantity
    const mozzarella = outWith.purchaseList.find((e) => e.ingredientId === "mozzarella")!;
    // net quantity for 4 portions = 400g; with 5% loss we buy ~421g
    expect(mozzarella.required).toBeGreaterThan(400);
  });

  it("unknown recipe emits a warning and still returns a result", async () => {
    const out = await tool.execute({ ...BASE_INPUT, recipeId: "mystery-dish" });
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.bomTree.ingredientId).toBe("mystery-dish");
  });

  it("missing ingredient price emits a warning (cost recorded as 0)", async () => {
    const out = await tool.execute({ ...BASE_INPUT, priceList: [] });
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.totalCost).toBe(0);
  });

  it("maxDepth=1 stops recursion at first level — sub-recipes become leaves", async () => {
    const out = await tool.execute({ ...BASE_INPUT, maxDepth: 1 });
    // At depth 1, pizza-dough should be treated as a leaf (no price → 0 cost + warning)
    expect(out.warnings.some((w) => w.includes("maxDepth"))).toBe(true);
  });

  it("tiramisu uses espresso sub-recipe (nested 2 levels)", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      recipeId: "tiramisu",
      portions: 6,
    });
    // espresso is a sub-recipe of tiramisu; ground-coffee is a leaf of espresso
    const gcEntry = out.purchaseList.find((e) => e.ingredientId === "ground-coffee");
    expect(gcEntry).toBeDefined();
    expect(gcEntry!.required).toBeGreaterThan(0);
  });

  it("is deterministic — same input same output", async () => {
    const out1 = await tool.execute(BASE_INPUT);
    const out2 = await tool.execute(BASE_INPUT);
    expect(out1.totalCost).toBe(out2.totalCost);
    expect(out1.purchaseList).toEqual(out2.purchaseList);
  });
});
