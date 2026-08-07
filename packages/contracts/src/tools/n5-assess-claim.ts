import { z } from "zod";

export const AssessClaimInputSchema = z.object({
  policy: z.object({
    sumInsured: z.number().positive(),
    deductible: z.number().nonnegative(),
    deductibleType: z
      .enum(["integral", "reductive"])
      .describe("integral: applies only when loss > deductible; reductive: always subtracted"),
    limits: z.array(
      z.object({
        category: z.string(),
        maxAmount: z.number().positive(),
      }),
    ),
    depreciationTable: z
      .array(
        z.object({
          ageYearsFrom: z.number().nonnegative(),
          ageYearsTo: z.number().positive(),
          depreciationPct: z.number().min(0).max(100),
        }),
      )
      .describe("Age-to-depreciation mapping for personal property"),
  }),
  claim: z.object({
    type: z.string().min(1).describe("Claim type e.g. 'fire', 'theft', 'water'"),
    estimatedLoss: z.number().positive(),
    itemAge: z.number().nonnegative().describe("Age of the claimed item in years"),
  }),
  evidence: z.array(z.string()).describe("Evidence document identifiers"),
});

export const AssessClaimOutputSchema = z.object({
  decision: z.enum(["approve", "reject", "review"]),
  payout: z.number().nonnegative(),
  deductibleApplied: z.number().nonnegative(),
  underinsuranceFactor: z
    .number()
    .min(0)
    .max(1)
    .describe("Proportional reduction when insured value < estimated replacement"),
  depreciation: z.number().nonnegative(),
  reasons: z.array(z.string()).describe("Human-readable explanation of each adjustment"),
});

export type AssessClaimInput = z.infer<typeof AssessClaimInputSchema>;
export type AssessClaimOutput = z.infer<typeof AssessClaimOutputSchema>;
