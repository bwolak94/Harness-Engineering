import { z } from "zod";

export const ExplodeRecipeCostInputSchema = z.object({
  recipeId: z.string().min(1),
  portions: z.number().positive(),
  stockLevels: z.array(
    z.object({
      ingredientId: z.string().min(1),
      quantityOnHand: z.number().nonnegative(),
      unit: z.string().min(1),
    }),
  ),
  priceList: z.array(
    z.object({
      ingredientId: z.string().min(1),
      pricePerUnit: z.number().nonnegative(),
      unit: z.string().min(1),
    }),
  ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum BOM recursion depth — guards against cycles"),
});

export const BomNodeSchema: z.ZodType<BomNode> = z.lazy(() =>
  z.object({
    ingredientId: z.string(),
    quantity: z.number().nonnegative(),
    unit: z.string(),
    unitCost: z.number().nonnegative(),
    totalCost: z.number().nonnegative(),
    children: z.array(z.lazy(() => BomNodeSchema)),
  }),
);

export type BomNode = {
  ingredientId: string;
  quantity: number;
  unit: string;
  unitCost: number;
  totalCost: number;
  children: BomNode[];
};

export const ExplodeRecipeCostOutputSchema = z.object({
  unitCost: z.number().nonnegative().describe("Cost per single portion"),
  totalCost: z.number().nonnegative(),
  margin: z.number().describe("Margin % if selling price is known; null otherwise"),
  bomTree: BomNodeSchema,
  purchaseList: z.array(
    z.object({
      ingredientId: z.string(),
      required: z.number().nonnegative(),
      onHand: z.number().nonnegative(),
      toBuy: z.number().nonnegative(),
      unit: z.string(),
      estimatedCost: z.number().nonnegative(),
    }),
  ),
  substitutions: z.array(
    z.object({
      original: z.string(),
      substitute: z.string(),
      reason: z.string(),
    }),
  ),
  warnings: z.array(z.string()).describe("Cycle detections, missing prices, etc."),
});

export type ExplodeRecipeCostInput = z.infer<typeof ExplodeRecipeCostInputSchema>;
export type ExplodeRecipeCostOutput = z.infer<typeof ExplodeRecipeCostOutputSchema>;
