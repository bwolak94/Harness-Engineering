import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../tools.js";
import {
  AnalyzeInvestmentInputSchema,
  AnalyzeInvestmentOutputSchema,
} from "./n1-analyze-investment.js";
import { OptimizeRouteInputSchema, OptimizeRouteOutputSchema } from "./n2-optimize-route.js";
import {
  CalculateLandedCostInputSchema,
  CalculateLandedCostOutputSchema,
} from "./n3-calculate-landed-cost.js";
import { BacktestRulesInputSchema, BacktestRulesOutputSchema } from "./n4-backtest-rules.js";
import { AssessClaimInputSchema, AssessClaimOutputSchema } from "./n5-assess-claim.js";
import {
  ScreenCandidatesInputSchema,
  ScreenCandidatesOutputSchema,
} from "./n6-screen-candidates.js";
import {
  ExplodeRecipeCostInputSchema,
  ExplodeRecipeCostOutputSchema,
} from "./n7-explode-recipe-cost.js";
import {
  SimulatePVPaybackInputSchema,
  SimulatePVPaybackOutputSchema,
} from "./n8-simulate-pv-payback.js";
import {
  CalculateNetSalaryInputSchema,
  CalculateNetSalaryOutputSchema,
} from "./n9-calculate-net-salary.js";
import {
  ProposeRepricingInputSchema,
  ProposeRepricingOutputSchema,
} from "./n10-propose-repricing.js";
import { ApplyRepricingInputSchema, ApplyRepricingOutputSchema } from "./n11-apply-repricing.js";

// Re-export individual schemas for direct use
export * from "./n1-analyze-investment.js";
export * from "./n2-optimize-route.js";
export * from "./n3-calculate-landed-cost.js";
export * from "./n4-backtest-rules.js";
export * from "./n5-assess-claim.js";
export * from "./n6-screen-candidates.js";
export * from "./n7-explode-recipe-cost.js";
export * from "./n8-simulate-pv-payback.js";
export * from "./n9-calculate-net-salary.js";
export * from "./n10-propose-repricing.js";
export * from "./n11-apply-repricing.js";

// ---------------------------------------------------------------------------
// Tool registry — all definitions in one place.
// JSON Schema for each is derived from the same Zod schema used for runtime
// validation, so they can never drift apart.
// ---------------------------------------------------------------------------

function toJsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  {
    name: "analyzeInvestment",
    description:
      "Calculates NOI, cap rate, cash-on-cash return, IRR, NPV, DSCR and break-even " +
      "occupancy for a real-estate investment. Returns cashflows[] and assumptions[].",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(AnalyzeInvestmentInputSchema),
    outputSchema: toJsonSchema(AnalyzeInvestmentOutputSchema),
  },
  {
    name: "optimizeRoute",
    description:
      "Optimises a vehicle route (nearest-neighbour + 2-opt) respecting time windows and " +
      "vehicle capacity. Returns quality field so the model knows if the result is heuristic.",
    dangerous: false,
    idempotent: true,
    costHint: "cheap",
    inputSchema: toJsonSchema(OptimizeRouteInputSchema),
    outputSchema: toJsonSchema(OptimizeRouteOutputSchema),
  },
  {
    name: "calculateLandedCost",
    description:
      "Calculates total landed cost (duty, VAT, excise, freight) for an international " +
      "shipment. Returns appliedRules[] for full audit trail.",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(CalculateLandedCostInputSchema),
    outputSchema: toJsonSchema(CalculateLandedCostOutputSchema),
  },
  {
    name: "backtestRules",
    description:
      "Backtests entry/exit trading rules on historical candle data. Returns aggregate " +
      "statistics and up to 5 sample trades — never the full trade list.",
    dangerous: false,
    idempotent: true,
    costHint: "moderate",
    inputSchema: toJsonSchema(BacktestRulesInputSchema),
    outputSchema: toJsonSchema(BacktestRulesOutputSchema),
  },
  {
    name: "assessClaim",
    description:
      "Evaluates an insurance claim: applies deductible, depreciation, under-insurance " +
      "factor and policy limits. Returns decision and reasons[].",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(AssessClaimInputSchema),
    outputSchema: toJsonSchema(AssessClaimOutputSchema),
  },
  {
    name: "screenCandidates",
    description:
      "Scores job candidates against a weighted rubric (mustHave/niceToHave skills). " +
      "Does NOT accept protected characteristics. Returns rubricBreakdown per candidate.",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(ScreenCandidatesInputSchema),
    outputSchema: toJsonSchema(ScreenCandidatesOutputSchema),
  },
  {
    name: "explodeRecipeCost",
    description:
      "Recursively expands a recipe BOM to leaf ingredients, computes unit and total cost, " +
      "and returns a purchase list. Detects cycles up to maxDepth.",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(ExplodeRecipeCostInputSchema),
    outputSchema: toJsonSchema(ExplodeRecipeCostOutputSchema),
  },
  {
    name: "simulatePVPayback",
    description:
      "Runs an 8760-step hourly photovoltaic simulation for a given location, returns " +
      "annual generation, self-consumption, savings and payback period.",
    dangerous: false,
    idempotent: true,
    costHint: "expensive",
    inputSchema: toJsonSchema(SimulatePVPaybackInputSchema),
    outputSchema: toJsonSchema(SimulatePVPaybackOutputSchema),
  },
  {
    name: "calculateNetSalary",
    description:
      "Calculates Polish net salary for UoP, zlecenie, or B2B contract types. Rates are " +
      "versioned by year parameter. Returns appliedThresholds[] for auditability.",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(CalculateNetSalaryInputSchema),
    outputSchema: toJsonSchema(CalculateNetSalaryOutputSchema),
  },
  {
    name: "proposeRepricing",
    description:
      "Proposes optimal prices for a product catalogue using demand elasticity and " +
      "competitor data. Proposal only — use applyRepricing to publish.",
    dangerous: false,
    idempotent: true,
    costHint: "cheap",
    inputSchema: toJsonSchema(ProposeRepricingInputSchema),
    outputSchema: toJsonSchema(ProposeRepricingOutputSchema),
  },
  {
    name: "applyRepricing",
    description:
      "Publishes approved price changes to the catalogue. DANGEROUS and irreversible. " +
      "Idempotent by idempotencyKey — safe to retry after crash.",
    dangerous: true,
    idempotent: true,
    costHint: "cheap",
    inputSchema: toJsonSchema(ApplyRepricingInputSchema),
    outputSchema: toJsonSchema(ApplyRepricingOutputSchema),
  },
  {
    name: "runCode",
    description:
      "Execute a JavaScript snippet in an isolated sandbox. Use to compute custom " +
      "transformations on data before passing to domain tools. Returns stdout, stderr, " +
      "and structured errors (SYNTAX_ERROR, TIMEOUT, MODULE_NOT_ALLOWED) for self-correction. " +
      "Network access is always disabled. Only JavaScript is supported.",
    dangerous: false,
    idempotent: false,
    costHint: "moderate",
    inputSchema: {},
    outputSchema: {},
  },
] as const;

/** Look up a tool definition by name. Returns undefined if not found. */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
