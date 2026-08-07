import { z } from "zod";

export const ProposeRepricingInputSchema = z.object({
  products: z
    .array(
      z.object({
        sku: z.string().min(1),
        cost: z.number().nonnegative(),
        currentPrice: z.number().nonnegative(),
        lastChangeAt: z.string().describe("ISO 8601 datetime of last price change"),
      }),
    )
    .min(1),
  competitorPrices: z.array(
    z.object({
      sku: z.string().min(1),
      competitorId: z.string().min(1),
      price: z.number().nonnegative(),
      capturedAt: z.string().describe("ISO 8601 datetime"),
    }),
  ),
  minMarginPct: z.number().min(0).max(100).describe("Hard floor: margin cannot go below this"),
  elasticity: z
    .number()
    .negative()
    .describe("Price elasticity of demand (must be negative, e.g. -1.5)"),
  cooldownHours: z.number().nonnegative().describe("Minimum hours between price changes per SKU"),
  maxDailyChangePct: z
    .number()
    .positive()
    .max(100)
    .describe("Maximum allowed price change % in a single day"),
});

export const ProposeRepricingOutputSchema = z.object({
  proposed: z.array(
    z.object({
      sku: z.string(),
      newPrice: z.number().nonnegative(),
      expectedMarginPct: z.number(),
      rationale: z.string().describe("Why this price was chosen"),
    }),
  ),
  blocked: z.array(
    z.object({
      sku: z.string(),
      reason: z.string().describe("Why no price change was proposed"),
    }),
  ),
});

export type ProposeRepricingInput = z.infer<typeof ProposeRepricingInputSchema>;
export type ProposeRepricingOutput = z.infer<typeof ProposeRepricingOutputSchema>;
