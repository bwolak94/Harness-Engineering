/**
 * Demo recipe catalogue for N7 — explodeRecipeCost.
 *
 * Follows the "Reguła fixtures" from plan.md: each data source has a
 * deterministic fixture provider (this file) as the default, with the real
 * adapter swapped at the composition root for production use.
 *
 * Schema:
 *   id            — unique recipe identifier; also used as ingredientId in parent recipes
 *   name          — human-readable display name
 *   basePortions  — number of portions the listed component quantities yield
 *   components    — list of ingredients (leaf or sub-recipe reference)
 *     ingredientId   — matches a leaf ingredient in the caller's priceList,
 *                      OR another recipe id in this catalogue (sub-recipe)
 *     quantity       — gross quantity needed per basePortions
 *     unit           — "portions" for sub-recipes; "g" / "ml" / "pcs" for leaves
 *     yieldLossPct   — optional: % of raw ingredient wasted during prep (0–100)
 *                      The tool grosses up required quantity by 1/(1 - yieldLossPct/100)
 *
 * NOTE: these are illustrative quantities for educational purposes.
 */

export interface RecipeComponent {
  ingredientId: string;
  quantity: number;
  unit: string;
  yieldLossPct?: number;
}

export interface RecipeEntry {
  id: string;
  name: string;
  basePortions: number;
  components: RecipeComponent[];
}

export const RECIPE_CATALOGUE: readonly RecipeEntry[] = [
  // ---------------------------------------------------------------------------
  // Shared sub-recipes (referenced by other recipes via ingredientId)
  // ---------------------------------------------------------------------------

  {
    id: "pizza-dough",
    name: "Pizza dough",
    basePortions: 4,
    components: [
      { ingredientId: "flour",     quantity: 300, unit: "g" },
      { ingredientId: "water",     quantity: 180, unit: "ml" },
      { ingredientId: "yeast",     quantity: 7,   unit: "g" },
      { ingredientId: "salt",      quantity: 6,   unit: "g" },
      { ingredientId: "olive-oil", quantity: 15,  unit: "ml" },
    ],
  },

  {
    id: "tomato-sauce",
    name: "Tomato sauce",
    basePortions: 4,
    components: [
      { ingredientId: "canned-tomatoes", quantity: 400, unit: "g" },
      { ingredientId: "basil",           quantity: 5,   unit: "g" },
      { ingredientId: "garlic",          quantity: 4,   unit: "g" },
      { ingredientId: "olive-oil",       quantity: 10,  unit: "ml" },
    ],
  },

  {
    id: "espresso",
    name: "Espresso shot (25 ml)",
    basePortions: 1,
    components: [
      { ingredientId: "ground-coffee", quantity: 9,  unit: "g" },
      { ingredientId: "water",         quantity: 25, unit: "ml" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Top-level recipes
  // ---------------------------------------------------------------------------

  {
    id: "pizza-margherita",
    name: "Pizza Margherita",
    basePortions: 4,
    components: [
      { ingredientId: "pizza-dough",  quantity: 4,   unit: "portions" },
      { ingredientId: "tomato-sauce", quantity: 4,   unit: "portions" },
      { ingredientId: "mozzarella",   quantity: 400, unit: "g", yieldLossPct: 5 },
      { ingredientId: "basil",        quantity: 8,   unit: "g" },
    ],
  },

  {
    id: "tiramisu",
    name: "Tiramisu",
    basePortions: 6,
    components: [
      { ingredientId: "mascarpone",   quantity: 500, unit: "g" },
      { ingredientId: "ladyfingers",  quantity: 200, unit: "g" },
      { ingredientId: "espresso",     quantity: 12,  unit: "portions" },
      { ingredientId: "egg-yolk",     quantity: 6,   unit: "pcs" },
      { ingredientId: "sugar",        quantity: 100, unit: "g" },
      { ingredientId: "cream",        quantity: 200, unit: "ml" },
      { ingredientId: "cocoa-powder", quantity: 20,  unit: "g" },
    ],
  },

  {
    id: "beef-stew",
    name: "Beef Stew",
    basePortions: 4,
    components: [
      { ingredientId: "beef-chuck",      quantity: 800, unit: "g", yieldLossPct: 10 },
      { ingredientId: "tomato-sauce",    quantity: 2,   unit: "portions" },
      { ingredientId: "red-wine",        quantity: 200, unit: "ml" },
      { ingredientId: "carrots",         quantity: 150, unit: "g" },
      { ingredientId: "onions",          quantity: 100, unit: "g" },
      { ingredientId: "flour",           quantity: 20,  unit: "g" },
      { ingredientId: "butter",          quantity: 30,  unit: "g" },
    ],
  },
];

/** Look up a recipe by id. Returns undefined if not found (ingredient is a leaf). */
export function findRecipe(id: string): RecipeEntry | undefined {
  return RECIPE_CATALOGUE.find((r) => r.id === id);
}
