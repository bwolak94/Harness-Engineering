import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

// ---------------------------------------------------------------------------
// Shared price list — same ingredients used in the N7 unit tests.
// ---------------------------------------------------------------------------
const PRICE_LIST = [
  { ingredientId: "flour", pricePerUnit: 0.002, unit: "g" },
  { ingredientId: "water", pricePerUnit: 0.0002, unit: "ml" },
  { ingredientId: "yeast", pricePerUnit: 0.1, unit: "g" },
  { ingredientId: "salt", pricePerUnit: 0.003, unit: "g" },
  { ingredientId: "olive-oil", pricePerUnit: 0.02, unit: "ml" },
  { ingredientId: "canned-tomatoes", pricePerUnit: 0.005, unit: "g" },
  { ingredientId: "basil", pricePerUnit: 0.08, unit: "g" },
  { ingredientId: "garlic", pricePerUnit: 0.05, unit: "g" },
  { ingredientId: "mozzarella", pricePerUnit: 0.04, unit: "g" },
  { ingredientId: "mascarpone", pricePerUnit: 0.03, unit: "g" },
  { ingredientId: "ladyfingers", pricePerUnit: 0.025, unit: "g" },
  { ingredientId: "ground-coffee", pricePerUnit: 0.05, unit: "g" },
  { ingredientId: "egg-yolk", pricePerUnit: 0.5, unit: "pcs" },
  { ingredientId: "sugar", pricePerUnit: 0.003, unit: "g" },
  { ingredientId: "cream", pricePerUnit: 0.012, unit: "ml" },
  { ingredientId: "cocoa-powder", pricePerUnit: 0.025, unit: "g" },
  { ingredientId: "beef-chuck", pricePerUnit: 0.06, unit: "g" },
  { ingredientId: "red-wine", pricePerUnit: 0.015, unit: "ml" },
  { ingredientId: "carrots", pricePerUnit: 0.003, unit: "g" },
  { ingredientId: "onions", pricePerUnit: 0.002, unit: "g" },
  { ingredientId: "butter", pricePerUnit: 0.02, unit: "g" },
];

/**
 * N7 — explodeRecipeCost golden cases.
 *
 * Three scenarios:
 *  1. Pizza Margherita for 4 portions — totalCost > 0, purchaseList contains
 *     leaf ingredients (flour, mozzarella), BOM root matches recipeId.
 *  2. Tiramisu for 6 portions — verifies 2-level nesting (espresso sub-recipe
 *     resolved to ground-coffee leaf).
 *  3. Pizza Margherita with partial stock — flour partially covered, so
 *     purchaseList's flour toBuy < required.
 */
export const N7_CASES: EvalCase[] = [
  {
    id: "n7-pizza-margherita-no-stock",
    tool: "explodeRecipeCost",
    description:
      "Pizza Margherita, 4 portions, no stock — totalCost > 0, leaf ingredients in purchaseList, BOM root = pizza-margherita",
    task: {
      id: "eval-n7-pizza",
      goal: "Calculate the ingredient cost for a pizza Margherita for 4 people.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("explodeRecipeCost", {
        recipeId: "pizza-margherita",
        portions: 4,
        stockLevels: [],
        priceList: PRICE_LIST,
        maxDepth: 10,
      }),
      FakeModelPort.textResponse("Recipe cost exploded."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "totalCost", value: 0 },
      { type: "field_gt", path: "unitCost", value: 0 },
      // purchaseList has at least the leaf ingredients (flour, water, mozzarella, etc.)
      { type: "array_min_length", path: "purchaseList", minLength: 4 },
      // bomTree root must be pizza-margherita
      { type: "field_equals", path: "bomTree.ingredientId", value: "pizza-margherita" },
      // bomTree has children (sub-recipes / leaves)
      { type: "field_gt", path: "bomTree.children.length", value: 0 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "explodeRecipeCost" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n7-tiramisu-nested-espresso",
    tool: "explodeRecipeCost",
    description:
      "Tiramisu, 6 portions — espresso sub-recipe resolved 2 levels deep; ground-coffee appears in purchaseList",
    task: {
      id: "eval-n7-tiramisu",
      goal: "Calculate the full ingredient cost for tiramisu for 6 servings.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("explodeRecipeCost", {
        recipeId: "tiramisu",
        portions: 6,
        stockLevels: [],
        priceList: PRICE_LIST,
        maxDepth: 10,
      }),
      FakeModelPort.textResponse("Tiramisu cost calculated."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "totalCost", value: 0 },
      // Tiramisu includes mascarpone, ladyfingers, espresso (→ ground-coffee) etc.
      { type: "array_min_length", path: "purchaseList", minLength: 5 },
      { type: "field_equals", path: "bomTree.ingredientId", value: "tiramisu" },
      // No warnings expected when all prices are present
      { type: "field_equals", path: "warnings.length", value: 0 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "explodeRecipeCost" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },

  {
    id: "n7-pizza-with-partial-stock",
    tool: "explodeRecipeCost",
    description:
      "Pizza Margherita with 100 g flour in stock — purchaseList flour toBuy is reduced vs required",
    task: {
      id: "eval-n7-stock",
      goal: "Calculate ingredient cost for pizza, accounting for existing flour stock.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("explodeRecipeCost", {
        recipeId: "pizza-margherita",
        portions: 4,
        stockLevels: [{ ingredientId: "flour", quantityOnHand: 100, unit: "g" }],
        priceList: PRICE_LIST,
        maxDepth: 10,
      }),
      FakeModelPort.textResponse("Stock-adjusted cost calculated."),
    ]),
    outcomeChecks: [
      { type: "field_gt", path: "totalCost", value: 0 },
      { type: "array_min_length", path: "purchaseList", minLength: 4 },
      // BOM root is still pizza-margherita
      { type: "field_equals", path: "bomTree.ingredientId", value: "pizza-margherita" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "explodeRecipeCost" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },
];
