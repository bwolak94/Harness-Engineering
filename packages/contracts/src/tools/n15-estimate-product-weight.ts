import { z } from "zod";

export const WeightComponentSchema = z.object({
  id: z.string().min(1).describe("Unique identifier matching the BOM component id"),
  name: z.string().min(1),
  quantity: z.number().int().positive().describe("Number of identical units in the assembly"),
  massGrams: z.number().nonnegative().describe("Mass per single unit in grams"),
  category: z
    .enum([
      "structural",
      "pcb",
      "battery",
      "mechanical",
      "optical",
      "connector",
      "fastener",
      "other",
    ])
    .default("other")
    .describe("Functional category — used for breakdown grouping"),
});

export const EstimateProductWeightInputSchema = z.object({
  components: z
    .array(WeightComponentSchema)
    .min(1)
    .max(500)
    .describe("All components that contribute to the finished product mass"),
  packagingMassGrams: z
    .number()
    .nonnegative()
    .default(0)
    .describe("Retail packaging mass (box, foam, accessories) in grams"),
  targetMaxWeightGrams: z
    .number()
    .positive()
    .optional()
    .describe("Product weight budget; triggers compliance check when provided"),
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const WeightBreakdownRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  quantity: z.number().int().positive(),
  unitMassGrams: z.number().nonnegative(),
  totalMassGrams: z.number().nonnegative(),
  percentOfProductWeight: z.number().min(0).max(100),
});

export const CategorySummarySchema = z.object({
  category: z.string(),
  totalMassGrams: z.number().nonnegative(),
  percentOfProductWeight: z.number().min(0).max(100),
  componentCount: z.number().int().nonnegative(),
});

export const EstimateProductWeightOutputSchema = z.object({
  totalProductWeightGrams: z.number().nonnegative().describe("Sum of all component masses"),
  componentBreakdown: z
    .array(WeightBreakdownRowSchema)
    .describe("Per-component contribution sorted descending by totalMassGrams"),
  categoryBreakdown: z
    .array(CategorySummarySchema)
    .describe("Aggregated mass by functional category"),
  packagingWeightGrams: z.number().nonnegative(),
  shippingWeightGrams: z
    .number()
    .nonnegative()
    .describe("totalProductWeightGrams + packagingWeightGrams"),
  targetMet: z.boolean().nullable().describe("null when targetMaxWeightGrams is not provided"),
  overageGrams: z
    .number()
    .nullable()
    .describe(
      "How many grams over budget; negative means under budget; null when no target provided",
    ),
  heaviestComponents: z
    .array(z.string())
    .max(5)
    .describe("Names of up to 5 heaviest components by total mass — prime reduction targets"),
  assumptions: z.array(z.string()),
});

export type WeightComponent = z.infer<typeof WeightComponentSchema>;
export type EstimateProductWeightInput = z.infer<typeof EstimateProductWeightInputSchema>;
export type WeightBreakdownRow = z.infer<typeof WeightBreakdownRowSchema>;
export type EstimateProductWeightOutput = z.infer<typeof EstimateProductWeightOutputSchema>;
