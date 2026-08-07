import { z } from "zod";

export const CalculateLandedCostInputSchema = z.object({
  hsCode: z.string().min(4).max(10).describe("Harmonized System code (4–10 digits)"),
  originCountry: z.string().length(2).describe("ISO 3166-1 alpha-2 country code"),
  destCountry: z.string().length(2).describe("ISO 3166-1 alpha-2 country code"),
  incoterm: z
    .enum(["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"])
    .describe("Incoterm 2020"),
  value: z.number().positive().describe("Declared customs value"),
  currency: z.string().length(3).describe("ISO 4217 currency code"),
  weightKg: z.number().positive(),
  freightCost: z.number().nonnegative(),
  preferentialOrigin: z
    .boolean()
    .default(false)
    .describe("Whether goods qualify for preferential tariff treatment"),
});

export const CalculateLandedCostOutputSchema = z.object({
  duty: z.number().nonnegative(),
  vat: z.number().nonnegative(),
  excise: z.number().nonnegative(),
  freight: z.number().nonnegative(),
  total: z.number().nonnegative(),
  effectiveRate: z.number().nonnegative().describe("Total duty as % of declared value"),
  appliedRules: z.array(z.string()).describe("Tariff rules applied (audit trail)"),
});

export type CalculateLandedCostInput = z.infer<typeof CalculateLandedCostInputSchema>;
export type CalculateLandedCostOutput = z.infer<typeof CalculateLandedCostOutputSchema>;
