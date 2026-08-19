import { z } from "zod";

export const RawTransactionSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  description: z.string().min(1),
  /** Negative = debit (expense), positive = credit (income). */
  amount: z.number(),
  currency: z.string().length(3).default("USD"),
});

export const CustomCategoryRuleSchema = z.object({
  name: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  amountMin: z.number().optional().describe("Match only debits ≥ this absolute value"),
  amountMax: z.number().optional().describe("Match only debits ≤ this absolute value"),
});

export const CategorizeTransactionsInputSchema = z.object({
  transactions: z.array(RawTransactionSchema).min(1).max(5000),
  customCategories: z
    .array(CustomCategoryRuleSchema)
    .optional()
    .default([])
    .describe("Caller-defined rules evaluated before built-in categories"),
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const TransactionCategorySummarySchema = z.object({
  category: z.string(),
  totalAmount: z.number().describe("Absolute sum of debits in this category"),
  transactionCount: z.number().int().nonnegative(),
  percentOfExpenses: z.number().min(0).max(100),
  transactionIds: z.array(z.string()),
});

export const MonthlyTrendRowSchema = z.object({
  month: z.string().describe("YYYY-MM"),
  income: z.number().nonnegative(),
  expenses: z.number().nonnegative(),
  netFlow: z.number(),
  byCategory: z.record(z.string(), z.number()),
});

export const TransactionAnomalySchema = z.object({
  transactionId: z.string(),
  reason: z.string(),
  severity: z.enum(["info", "warning", "alert"]),
});

export const CategorizeTransactionsOutputSchema = z.object({
  summary: z.object({
    totalIncome: z.number().nonnegative(),
    totalExpenses: z.number().nonnegative(),
    netFlow: z.number(),
    currency: z.string(),
    periodFrom: z.string(),
    periodTo: z.string(),
  }),
  byCategory: z
    .array(TransactionCategorySummarySchema)
    .describe("Sorted descending by totalAmount"),
  uncategorizedIds: z
    .array(z.string())
    .describe("Transaction ids that matched no built-in or custom rule"),
  monthlyTrend: z.array(MonthlyTrendRowSchema),
  anomalies: z.array(TransactionAnomalySchema),
  assumptions: z.array(z.string()),
});

export type RawTransaction = z.infer<typeof RawTransactionSchema>;
export type CustomCategoryRule = z.infer<typeof CustomCategoryRuleSchema>;
export type CategorizeTransactionsInput = z.infer<typeof CategorizeTransactionsInputSchema>;
export type TransactionCategorySummary = z.infer<typeof TransactionCategorySummarySchema>;
export type CategorizeTransactionsOutput = z.infer<typeof CategorizeTransactionsOutputSchema>;
