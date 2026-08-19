import { z } from "zod";

export const BomComponentSchema = z.object({
  id: z.string().min(1).describe("Unique component identifier"),
  name: z.string().min(1),
  quantity: z.number().positive().describe("Number of units consumed per finished product"),
  unitCostBase: z.number().nonnegative().describe("Base unit cost before any volume discount"),
  volumeDiscounts: z
    .array(
      z.object({
        minQty: z.number().int().positive().describe("Minimum order quantity for this bracket"),
        discountPct: z.number().min(0).max(80).describe("Discount applied to unitCostBase (%)"),
      }),
    )
    .default([])
    .describe("Volume-discount brackets sorted ascending by minQty"),
});

export const EstimateProductionCostInputSchema = z.object({
  bom: z
    .array(BomComponentSchema)
    .min(1)
    .max(200)
    .describe("Bill of materials — leaf components only (no sub-assemblies)"),
  labor: z.object({
    hoursPerUnit: z.number().nonnegative().describe("Direct labour hours per finished unit"),
    hourlyRate: z.number().nonnegative().describe("Fully-loaded labour cost per hour"),
  }),
  overheadPct: z
    .number()
    .min(0)
    .max(500)
    .describe("Factory overhead as % of (material + labour) costs"),
  toolingFixedCost: z
    .number()
    .nonnegative()
    .default(0)
    .describe("One-time tooling / mould cost amortised across each production run volume"),
  productionVolumes: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("List of production volumes to evaluate, e.g. [100, 1000, 10000]"),
  targetRetailPrice: z
    .number()
    .positive()
    .optional()
    .describe("If provided, gross margin % is computed at each volume"),
});

export const VolumeBreakdownRowSchema = z.object({
  volume: z.number().int().positive(),
  materialCostPerUnit: z.number().nonnegative(),
  laborCostPerUnit: z.number().nonnegative(),
  overheadCostPerUnit: z.number().nonnegative(),
  toolingAmortizedPerUnit: z.number().nonnegative(),
  unitCostTotal: z.number().nonnegative(),
  grossMarginPct: z
    .number()
    .optional()
    .describe("Gross margin % at targetRetailPrice; omitted when targetRetailPrice not provided"),
});

export const EstimateProductionCostOutputSchema = z.object({
  volumeBreakdown: z
    .array(VolumeBreakdownRowSchema)
    .describe("One row per requested production volume"),
  minimumViableVolume: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Smallest volume at which unitCostTotal ≤ targetRetailPrice × 0.5 (50% margin floor). " +
        "Omitted when targetRetailPrice is not provided.",
    ),
  assumptions: z.array(z.string()).describe("Audit trail of every material computation step"),
});

export type BomComponent = z.infer<typeof BomComponentSchema>;
export type EstimateProductionCostInput = z.infer<typeof EstimateProductionCostInputSchema>;
export type EstimateProductionCostOutput = z.infer<typeof EstimateProductionCostOutputSchema>;
