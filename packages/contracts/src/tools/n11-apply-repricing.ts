import { z } from "zod";

/**
 * N11 — applyRepricing
 * dangerous: true — price changes are irreversible once published.
 * idempotent by idempotencyKey: replaying with the same key returns the same
 * result without re-applying changes.
 */
export const ApplyRepricingInputSchema = z.object({
  changes: z
    .array(
      z.object({
        sku: z.string().min(1),
        newPrice: z.number().nonnegative(),
      }),
    )
    .min(1),
  idempotencyKey: z
    .string()
    .min(1)
    .describe("Caller-generated key — replayed requests with the same key are no-ops"),
  effectiveAt: z.string().describe("ISO 8601 datetime when prices go live"),
});

export const ApplyRepricingOutputSchema = z.object({
  applied: z.array(
    z.object({
      sku: z.string(),
      previousPrice: z.number().nonnegative(),
      newPrice: z.number().nonnegative(),
      appliedAt: z.string(),
    }),
  ),
  skipped: z.array(
    z.object({
      sku: z.string(),
      reason: z.enum(["duplicate", "stale", "rejected"]),
      detail: z.string().optional(),
    }),
  ),
});

export type ApplyRepricingInput = z.infer<typeof ApplyRepricingInputSchema>;
export type ApplyRepricingOutput = z.infer<typeof ApplyRepricingOutputSchema>;
