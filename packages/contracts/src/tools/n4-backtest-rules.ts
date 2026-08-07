import { z } from "zod";

/**
 * RuleExpr — minimal DSL for entry/exit conditions.
 * Example: { indicator: "SMA", params: { period: 20 }, op: "crossAbove", value: "price" }
 *
 * NOTE: The explicit ZodType<RuleExpr> annotation is avoided here because Zod v3's
 * .optional() infers `T | undefined` which clashes with exactOptionalPropertyTypes.
 * Runtime validation is provided by the schema; TypeScript safety by the manual type.
 */
// biome-ignore lint/suspicious/noExplicitAny: recursive Zod schema requires ZodType<any> due to z.lazy — see ADR 0002
export const RuleExprSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({
      indicator: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
      op: z.enum(["crossAbove", "crossBelow", "greaterThan", "lessThan", "equals"]),
      value: z.union([z.number(), z.string()]),
    }),
    z.object({
      and: z.array(z.lazy(() => RuleExprSchema)),
    }),
    z.object({
      or: z.array(z.lazy(() => RuleExprSchema)),
    }),
    z.object({
      not: z.lazy(() => RuleExprSchema),
    }),
  ]),
);

export type RuleExpr =
  | {
      indicator: string;
      params?: Record<string, unknown>;
      op: "crossAbove" | "crossBelow" | "greaterThan" | "lessThan" | "equals";
      value: number | string;
    }
  | { and: RuleExpr[] }
  | { or: RuleExpr[] }
  | { not: RuleExpr };

export const BacktestRulesInputSchema = z.object({
  symbol: z.string().min(1).describe("Ticker symbol, e.g. 'AAPL'"),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]),
  range: z.object({
    from: z.string().describe("ISO 8601 date"),
    to: z.string().describe("ISO 8601 date"),
  }),
  entry: RuleExprSchema,
  exit: RuleExprSchema,
  riskPct: z.number().positive().max(100).describe("% of capital risked per trade"),
  initialCapital: z.number().positive(),
});

export const BacktestRulesOutputSchema = z.object({
  stats: z.object({
    trades: z.number().int().nonnegative(),
    winRate: z.number().min(0).max(1),
    profitFactor: z.number().nonnegative(),
    expectancyR: z.number().describe("Expected return in R-multiples per trade"),
    maxDrawdownPct: z.number().nonnegative(),
    sharpe: z.number(),
  }),
  sampleTrades: z
    .array(
      z.object({
        entryAt: z.string(),
        exitAt: z.string(),
        entryPrice: z.number(),
        exitPrice: z.number(),
        rMultiple: z.number(),
        pnl: z.number(),
      }),
    )
    .max(5)
    .describe("Up to 5 representative trades (never full array to protect context)"),
  equityCurveSummary: z.object({
    startValue: z.number(),
    endValue: z.number(),
    peakValue: z.number(),
    troughValue: z.number(),
    monthlyReturns: z.array(z.number()),
  }),
});

export type BacktestRulesInput = z.infer<typeof BacktestRulesInputSchema>;
export type BacktestRulesOutput = z.infer<typeof BacktestRulesOutputSchema>;
