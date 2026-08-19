import { z } from "zod";

export const SubscriptionTransactionSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  description: z.string().min(1),
  /** Must be positive (debit amount). */
  amount: z.number().positive(),
  currency: z.string().length(3).default("USD"),
});

export const DetectSubscriptionDriftInputSchema = z.object({
  transactions: z
    .array(SubscriptionTransactionSchema)
    .min(1)
    .max(5000)
    .describe("Debit transactions only — credits are ignored"),
  lookbackMonths: z
    .number()
    .int()
    .min(1)
    .max(36)
    .default(12)
    .describe("How many months of history to analyse"),
  amountTolerancePct: z
    .number()
    .min(0)
    .max(50)
    .default(5)
    .describe(
      "Two charges are considered the 'same subscription amount' if within this % of each other",
    ),
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const PricePointSchema = z.object({
  date: z.string(),
  amount: z.number().positive(),
});

export const DetectedSubscriptionSchema = z.object({
  name: z.string().describe("Normalised merchant name"),
  frequency: z.enum(["weekly", "monthly", "quarterly", "annual", "irregular"]),
  firstChargeDate: z.string(),
  lastChargeDate: z.string(),
  lastChargeAmount: z.number().positive(),
  priceHistory: z.array(PricePointSchema),
  driftPct: z
    .number()
    .nullable()
    .describe("% change from first to last charge amount; null if only one charge"),
  status: z.enum(["stable", "increased", "decreased", "potentially_cancelled"]),
  totalPaidInPeriod: z.number().nonnegative(),
  transactionIds: z.array(z.string()),
});

export const DriftAlertSchema = z.object({
  subscriptionName: z.string(),
  alertType: z.enum(["price_increase", "forgotten", "duplicate", "irregular_charge"]),
  detail: z.string(),
  suggestedAction: z.string(),
  severity: z.enum(["info", "warning", "alert"]),
});

export const DetectSubscriptionDriftOutputSchema = z.object({
  subscriptions: z
    .array(DetectedSubscriptionSchema)
    .describe("Sorted descending by totalPaidInPeriod"),
  monthlySubscriptionTotal: z
    .number()
    .nonnegative()
    .describe("Estimated total monthly cost (annual subscriptions divided by 12)"),
  annualSubscriptionTotal: z.number().nonnegative(),
  driftAlerts: z.array(DriftAlertSchema),
  nonRecurringTransactionCount: z
    .number()
    .int()
    .nonnegative()
    .describe("Transactions that did not match any recurring pattern"),
  assumptions: z.array(z.string()),
});

export type SubscriptionTransaction = z.infer<typeof SubscriptionTransactionSchema>;
export type DetectedSubscription = z.infer<typeof DetectedSubscriptionSchema>;
export type DetectSubscriptionDriftInput = z.infer<typeof DetectSubscriptionDriftInputSchema>;
export type DetectSubscriptionDriftOutput = z.infer<typeof DetectSubscriptionDriftOutputSchema>;
