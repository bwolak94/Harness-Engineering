import type { ToolDefinition } from "@harness/contracts";
import { findRecipe } from "@harness/contracts/data/recipes";
import {
  type BomNode,
  type ExplodeRecipeCostInput,
  ExplodeRecipeCostInputSchema,
  type ExplodeRecipeCostOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// N7 — explodeRecipeCost
//
// Recursively expands a recipe BOM (bill of materials) to leaf ingredients,
// computes unit and total cost, and returns a purchase list.
//
// The recipe structure comes from the static RECIPE_CATALOGUE fixture in
// packages/contracts/src/data/recipes.ts. Prices and stock levels are
// provided by the caller at runtime (they change; the BOM structure does not).
//
// Cycle detection is handled by:
//   1. A `visited` Set tracking the current recursion path (structural cycles).
//   2. The `maxDepth` parameter (accidental deep nesting, e.g. maxDepth=10).
//
// Design note: yieldLossPct is the % of raw ingredient wasted during prep.
// If quantity = 100g and yieldLossPct = 10, we gross up to 100/(1-0.1) ≈ 111g
// to ensure 100g net ends up in the dish.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PriceEntry {
  pricePerUnit: number;
  unit: string;
}

interface StockEntry {
  quantityOnHand: number;
  unit: string;
}

type PriceMap = Map<string, PriceEntry>;
type StockMap = Map<string, StockEntry>;

interface LeafAccumEntry {
  required: number;
  onHand: number;
  unit: string;
  estimatedCost: number;
}
type LeafAccum = Map<string, LeafAccumEntry>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build a leaf BomNode, accumulate its requirement in leafAccum.
 */
function buildLeafNode(
  ingredientId: string,
  grossQty: number,
  unit: string,
  priceMap: PriceMap,
  stockMap: StockMap,
  leafAccum: LeafAccum,
  warnings: string[],
): BomNode {
  const priceEntry = priceMap.get(ingredientId);

  if (!priceEntry) {
    warnings.push(`No price found for ingredient '${ingredientId}'. Cost recorded as 0.`);
  }

  const pricePerUnit = priceEntry?.pricePerUnit ?? 0;

  if (priceEntry && priceEntry.unit !== unit) {
    warnings.push(
      `Unit mismatch for '${ingredientId}': recipe uses '${unit}', price list uses '${priceEntry.unit}'. Verify quantities.`,
    );
  }

  const totalCost = grossQty * pricePerUnit;

  // Accumulate into the flat purchase list
  const acc = leafAccum.get(ingredientId);
  const stockEntry = stockMap.get(ingredientId);
  const onHand = stockEntry?.quantityOnHand ?? 0;

  if (acc) {
    acc.required += grossQty;
    acc.estimatedCost += totalCost;
  } else {
    leafAccum.set(ingredientId, {
      required: grossQty,
      onHand,
      unit,
      estimatedCost: totalCost,
    });
  }

  return {
    ingredientId,
    quantity: round3(grossQty),
    unit,
    unitCost: pricePerUnit,
    totalCost: round2(totalCost),
    children: [],
  };
}

/**
 * Recursively explode a recipe or leaf ingredient into a BomNode.
 *
 * @param ingredientId  recipe id or leaf ingredient id
 * @param requestedQty  how many "units" we need (portions for recipes, raw quantity for leaves)
 * @param unit          unit of requestedQty
 * @param depth         current recursion depth
 * @param visited       set of recipe ids currently on the recursion stack (cycle detection)
 */
function explodeNode(
  ingredientId: string,
  requestedQty: number,
  unit: string,
  depth: number,
  visited: Set<string>,
  priceMap: PriceMap,
  stockMap: StockMap,
  leafAccum: LeafAccum,
  warnings: string[],
  maxDepth: number,
): BomNode {
  const recipe = findRecipe(ingredientId);

  // Treat as a leaf when we've exceeded maxDepth or when no recipe exists
  if (!recipe || depth >= maxDepth) {
    if (recipe && depth >= maxDepth) {
      warnings.push(
        `maxDepth ${maxDepth} reached at '${ingredientId}'. Treating as leaf ingredient.`,
      );
    }
    return buildLeafNode(ingredientId, requestedQty, unit, priceMap, stockMap, leafAccum, warnings);
  }

  // Cycle detection: if this recipe is already on the current path, stop
  if (visited.has(ingredientId)) {
    warnings.push(
      `Cycle detected: '${ingredientId}' is already in the current BOM path. Skipping to prevent infinite recursion.`,
    );
    return buildLeafNode(ingredientId, requestedQty, unit, priceMap, stockMap, leafAccum, warnings);
  }

  visited.add(ingredientId);

  // Scale all component quantities to match the requested portion count
  const scale = requestedQty / recipe.basePortions;

  const children: BomNode[] = recipe.components.map((comp) => {
    // Gross up for yield loss: if 10% is wasted, buy 1/(1-0.10) = 1.111× more
    const yieldFactor = comp.yieldLossPct ? 1 / (1 - comp.yieldLossPct / 100) : 1;
    const grossQty = comp.quantity * scale * yieldFactor;
    return explodeNode(
      comp.ingredientId,
      grossQty,
      comp.unit,
      depth + 1,
      visited,
      priceMap,
      stockMap,
      leafAccum,
      warnings,
      maxDepth,
    );
  });

  visited.delete(ingredientId);

  const totalCost = children.reduce((sum, c) => sum + c.totalCost, 0);
  const unitCost = requestedQty > 0 ? totalCost / requestedQty : 0;

  return {
    ingredientId,
    quantity: round3(requestedQty),
    unit,
    unitCost: round4(unitCost),
    totalCost: round2(totalCost),
    children,
  };
}

function buildPurchaseList(leafAccum: LeafAccum) {
  return [...leafAccum.entries()].map(([id, data]) => {
    const toBuy = Math.max(0, data.required - data.onHand);
    return {
      ingredientId: id,
      required: round3(data.required),
      onHand: round3(data.onHand),
      toBuy: round3(toBuy),
      unit: data.unit,
      estimatedCost: round2(data.estimatedCost),
    };
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExplodeRecipeCostTool(
  definition: ToolDefinition,
): Tool<ExplodeRecipeCostInput, ExplodeRecipeCostOutput> {
  return {
    definition,
    inputSchema: ExplodeRecipeCostInputSchema,

    async execute(input): Promise<ExplodeRecipeCostOutput> {
      const { recipeId, portions, stockLevels, priceList, maxDepth } = input;

      // Build O(1) lookup maps
      const priceMap: PriceMap = new Map(priceList.map((p) => [p.ingredientId, p]));
      const stockMap: StockMap = new Map(stockLevels.map((s) => [s.ingredientId, s]));
      const leafAccum: LeafAccum = new Map();
      const warnings: string[] = [];
      const visited = new Set<string>();

      // Explode the root recipe
      const bomTree = explodeNode(
        recipeId,
        portions,
        "portions",
        0,
        visited,
        priceMap,
        stockMap,
        leafAccum,
        warnings,
        maxDepth,
      );

      const purchaseList = buildPurchaseList(leafAccum);
      const unitCost = portions > 0 ? bomTree.totalCost / portions : 0;

      return {
        unitCost: round4(unitCost),
        totalCost: round2(bomTree.totalCost),
        // margin is 0 when no selling price is known (the schema type is number)
        margin: 0,
        bomTree,
        purchaseList,
        // No substitution database in the fixture — returned as empty
        substitutions: [],
        warnings,
      };
    },
  };
}
