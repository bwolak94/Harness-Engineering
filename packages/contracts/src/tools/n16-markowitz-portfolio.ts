import { z } from "zod";

export const MarkowitzAssetSchema = z.object({
  name: z.string().min(1).describe("Unique asset identifier (ticker, fund name, etc.)"),
  expectedReturn: z
    .number()
    .describe("Expected annual return as a decimal (0.12 = 12%). Can be negative."),
});

export const MarkowitzPortfolioInputSchema = z.object({
  assets: z
    .array(MarkowitzAssetSchema)
    .min(2)
    .max(20)
    .describe("Assets to include in the portfolio. Order must match covarianceMatrix rows/columns."),
  covarianceMatrix: z
    .array(z.array(z.number()))
    .describe(
      "Annual covariance matrix (n×n). Must be square, symmetric, and positive definite. " +
        "Entry [i][j] is the covariance between asset i and asset j. " +
        "Diagonal entry [i][i] is the variance of asset i (stdDev²).",
    ),
  riskFreeRate: z
    .number()
    .nonnegative()
    .describe("Annual risk-free rate as a decimal (0.05 = 5%). Used for Sharpe ratio."),
  targetVolatility: z
    .number()
    .positive()
    .optional()
    .describe(
      "If provided, return the minimum-variance efficient portfolio achieving this annual " +
        "volatility (std dev as decimal). If omitted, return the maximum Sharpe ratio portfolio.",
    ),
  allowShortSelling: z
    .boolean()
    .default(false)
    .describe(
      "Allow negative portfolio weights (short positions). " +
        "When false (default), all weights are constrained to [0, 1].",
    ),
});

export const EfficientFrontierPointSchema = z.object({
  volatility: z.number().describe("Annual portfolio volatility (std dev) at this point"),
  expectedReturn: z.number().describe("Expected annual portfolio return at this point"),
  sharpeRatio: z.number().describe("Sharpe ratio at this point"),
});

export const MarkowitzPortfolioOutputSchema = z.object({
  weights: z
    .record(z.string(), z.number())
    .describe(
      "Optimal portfolio weights keyed by asset name. " +
        "Values sum to 1. Negative values indicate short positions.",
    ),
  portfolioReturn: z.number().describe("Expected annual return of the optimal portfolio"),
  portfolioVolatility: z
    .number()
    .nonnegative()
    .describe("Annual volatility (std dev) of the optimal portfolio"),
  sharpeRatio: z.number().describe("Sharpe ratio of the optimal portfolio"),
  efficientFrontierPoints: z
    .array(EfficientFrontierPointSchema)
    .describe(
      "21 points tracing the efficient frontier from the global minimum-variance portfolio " +
        "to the maximum-return portfolio. Useful for rendering a risk–return chart.",
    ),
  assumptions: z
    .array(z.string())
    .describe("Human-readable audit trail of optimization decisions applied"),
});

export type MarkowitzAsset = z.infer<typeof MarkowitzAssetSchema>;
export type MarkowitzPortfolioInput = z.infer<typeof MarkowitzPortfolioInputSchema>;
export type MarkowitzPortfolioOutput = z.infer<typeof MarkowitzPortfolioOutputSchema>;
export type EfficientFrontierPoint = z.infer<typeof EfficientFrontierPointSchema>;
