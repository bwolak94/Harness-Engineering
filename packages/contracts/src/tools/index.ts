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
import { SearchHotelsInputSchema, SearchHotelsOutputSchema } from "./n12-search-hotels.js";
import {
  EstimateProductionCostInputSchema,
  EstimateProductionCostOutputSchema,
} from "./n13-estimate-production-cost.js";
import {
  CheckDesignFeasibilityInputSchema,
  CheckDesignFeasibilityOutputSchema,
} from "./n14-check-design-feasibility.js";
import {
  EstimateProductWeightInputSchema,
  EstimateProductWeightOutputSchema,
} from "./n15-estimate-product-weight.js";
import {
  MarkowitzPortfolioInputSchema,
  MarkowitzPortfolioOutputSchema,
} from "./n16-markowitz-portfolio.js";

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
export * from "./n12-search-hotels.js";
export * from "./n13-estimate-production-cost.js";
export * from "./n14-check-design-feasibility.js";
export * from "./n15-estimate-product-weight.js";
export * from "./n16-markowitz-portfolio.js";

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
    exampleInput: {
      price: 850000,
      rentRoll: [{ unit: "A1", monthlyRent: 3500, occupancyPct: 95 }],
      opex: [{ category: "maintenance", annualAmount: 8000 }],
      loan: { amount: 600000, rateAnnualPct: 0.06, termYears: 20, type: "annuity" },
      horizonYears: 10,
      exitCapRate: 0.055,
    },
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
    exampleInput: {
      depot: { lat: 52.23, lng: 21.01 },
      stops: [
        {
          id: "S1",
          lat: 52.4,
          lng: 20.98,
          demand: 10,
          windowFrom: "2026-08-12T08:00:00Z",
          windowTo: "2026-08-12T12:00:00Z",
          serviceMin: 15,
        },
        {
          id: "S2",
          lat: 52.15,
          lng: 21.22,
          demand: 8,
          windowFrom: "2026-08-12T09:00:00Z",
          windowTo: "2026-08-12T14:00:00Z",
          serviceMin: 10,
        },
        {
          id: "S3",
          lat: 52.28,
          lng: 20.85,
          demand: 12,
          windowFrom: "2026-08-12T10:00:00Z",
          windowTo: "2026-08-12T16:00:00Z",
          serviceMin: 20,
        },
      ],
      vehicleCapacity: 50,
      maxComputeMs: 5000,
    },
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
    exampleInput: {
      hsCode: "8471300000",
      originCountry: "CN",
      destCountry: "PL",
      incoterm: "FOB",
      value: 10000,
      currency: "USD",
      weightKg: 50,
      freightCost: 800,
      preferentialOrigin: false,
    },
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
    exampleInput: {
      symbol: "AAPL",
      timeframe: "1d",
      range: { from: "2024-01-01", to: "2024-12-31" },
      entry: { indicator: "SMA", params: { period: 20 }, op: "crossAbove", value: "price" },
      exit: { indicator: "SMA", params: { period: 50 }, op: "crossBelow", value: "price" },
      initialCapital: 10000,
      positionSizePct: 100,
    },
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
    exampleInput: {
      policy: {
        sumInsured: 120000,
        deductible: 500,
        deductibleType: "reductive",
        limits: [{ category: "electronics", maxAmount: 5000 }],
        depreciationTable: [
          { ageYearsFrom: 0, ageYearsTo: 3, depreciationPct: 0 },
          { ageYearsFrom: 3, ageYearsTo: 10, depreciationPct: 15 },
        ],
      },
      claim: { type: "fire", estimatedLoss: 3200, itemAge: 2 },
      evidence: ["photo-001", "invoice-002"],
    },
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
    exampleInput: {
      jobSpec: { mustHave: ["TypeScript", "Node.js"], niceToHave: ["Kubernetes", "PostgreSQL"] },
      candidates: [
        {
          id: "cand-001",
          skills: ["TypeScript", "Node.js", "PostgreSQL"],
          experience: [{ role: "Backend Engineer", durationMonths: 36, level: "senior" }],
          certifications: ["AWS Solutions Architect"],
        },
        {
          id: "cand-002",
          skills: ["TypeScript", "React"],
          experience: [{ role: "Frontend Engineer", durationMonths: 24, level: "mid" }],
        },
      ],
    },
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
    exampleInput: {
      recipeId: "pizza-margherita",
      portions: 4,
      stockLevels: [
        { ingredientId: "flour", quantityOnHand: 2.0, unit: "kg" },
        { ingredientId: "tomato-sauce", quantityOnHand: 1.5, unit: "kg" },
        { ingredientId: "mozzarella", quantityOnHand: 0.8, unit: "kg" },
      ],
      priceList: [
        { ingredientId: "flour", pricePerUnit: 1.2, unit: "kg" },
        { ingredientId: "tomato-sauce", pricePerUnit: 2.5, unit: "kg" },
        { ingredientId: "mozzarella", pricePerUnit: 8.0, unit: "kg" },
      ],
      maxDepth: 5,
    },
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
    // consumptionProfile requires exactly 8760 values — impractical to show in a UI textarea.
    // The sandbox buildTemplate fallback will generate the array automatically.
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
    exampleInput: {
      gross: 8000,
      contractType: "uop",
      year: 2024,
      taxReliefs: [],
      ppkRate: 2,
      jointFiling: false,
    },
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
    exampleInput: {
      products: [
        { sku: "LAPTOP-001", cost: 800, currentPrice: 1199, lastChangeAt: "2026-07-01T00:00:00Z" },
        { sku: "MOUSE-002", cost: 15, currentPrice: 39, lastChangeAt: "2026-07-15T00:00:00Z" },
      ],
      competitorPrices: [
        {
          sku: "LAPTOP-001",
          competitorId: "shop-a",
          price: 1149,
          capturedAt: "2026-08-10T12:00:00Z",
        },
        { sku: "MOUSE-002", competitorId: "shop-a", price: 35, capturedAt: "2026-08-10T12:00:00Z" },
      ],
      minMarginPct: 15,
      elasticity: -1.5,
      cooldownHours: 24,
      maxDailyChangePct: 10,
    },
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
    exampleInput: {
      changes: [{ sku: "LAPTOP-001", newPrice: 1149 }],
      idempotencyKey: "repricing-2026-08-11-batch-1",
    },
  },
  {
    name: "searchHotels",
    description:
      "Finds hotels, hostels, and guest houses near a location using OpenStreetMap data " +
      "(Nominatim geocoding + Overpass API). Returns hotel listings with distances, star ratings, " +
      "amenities, and nearby public transit stops (bus, tram, subway) within 500 m of each property. " +
      "No API key required. Coverage depends on OSM community contributions — best in Europe.",
    dangerous: false,
    idempotent: false,
    costHint: "cheap",
    inputSchema: toJsonSchema(SearchHotelsInputSchema),
    outputSchema: toJsonSchema(SearchHotelsOutputSchema),
    exampleInput: {
      location: "Kraków Old Town, Poland",
      radiusKm: 1,
      maxResults: 8,
      checkIn: "2026-09-15",
      checkOut: "2026-09-18",
    },
  },
  {
    name: "markowitzPortfolio",
    description:
      "Computes the optimal Markowitz mean-variance portfolio for a given asset universe. " +
      "Returns portfolio weights, expected return, volatility, Sharpe ratio, and 21 efficient " +
      "frontier points for risk–return charting. Supports long-only and unconstrained (short-selling) modes. " +
      "When targetVolatility is provided, returns the minimum-variance portfolio at that risk level; " +
      "otherwise returns the maximum Sharpe ratio (tangency) portfolio.",
    dangerous: false,
    idempotent: true,
    costHint: "cheap",
    inputSchema: toJsonSchema(MarkowitzPortfolioInputSchema),
    outputSchema: toJsonSchema(MarkowitzPortfolioOutputSchema),
    exampleInput: {
      assets: [
        { name: "SPY", expectedReturn: 0.1 },
        { name: "BND", expectedReturn: 0.04 },
        { name: "GLD", expectedReturn: 0.06 },
      ],
      covarianceMatrix: [
        [0.04, 0.002, 0.006],
        [0.002, 0.0009, 0.0005],
        [0.006, 0.0005, 0.0144],
      ],
      riskFreeRate: 0.05,
      allowShortSelling: false,
    },
  },
  {
    name: "estimateProductionCost",
    description:
      "Calculates unit production cost from a Bill of Materials + labour at multiple production " +
      "volumes. Applies per-component volume discounts, amortises tooling fixed costs, and " +
      "projects gross margin at a target retail price. Returns volumeBreakdown[] and assumptions[].",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(EstimateProductionCostInputSchema),
    outputSchema: toJsonSchema(EstimateProductionCostOutputSchema),
    exampleInput: {
      bom: [
        {
          id: "mcu-stm32",
          name: "STM32L4 MCU",
          quantity: 1,
          unitCostBase: 4.5,
          volumeDiscounts: [
            { minQty: 1000, discountPct: 10 },
            { minQty: 10000, discountPct: 22 },
          ],
        },
        {
          id: "abs-enclosure",
          name: "ABS enclosure",
          quantity: 1,
          unitCostBase: 2.8,
          volumeDiscounts: [{ minQty: 5000, discountPct: 15 }],
        },
        {
          id: "lipo-battery",
          name: "LiPo 1000 mAh",
          quantity: 1,
          unitCostBase: 3.2,
          volumeDiscounts: [],
        },
      ],
      labor: { hoursPerUnit: 0.25, hourlyRate: 18 },
      overheadPct: 30,
      toolingFixedCost: 12000,
      productionVolumes: [500, 2000, 10000],
      targetRetailPrice: 49.99,
    },
  },
  {
    name: "checkDesignFeasibility",
    description:
      "Scores a hardware product design against its requirements (weight, dimensions, IP rating, " +
      "temperature range, cost, drop test, certifications). Returns a 0–1 feasibilityScore, " +
      "hard/soft violations[], warnings[], and actionable recommendations[].",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(CheckDesignFeasibilityInputSchema),
    outputSchema: toJsonSchema(CheckDesignFeasibilityOutputSchema),
    exampleInput: {
      requirements: {
        maxWeightGrams: 150,
        maxLengthMm: 120,
        maxWidthMm: 70,
        maxHeightMm: 20,
        ipRating: "IP67",
        operatingTempMinC: -20,
        operatingTempMaxC: 60,
        targetUnitCostUsd: 18,
        dropTestHeightM: 1.5,
        requiredCertifications: ["CE", "FCC", "RoHS"],
      },
      design: {
        estimatedWeightGrams: 162,
        lengthMm: 118,
        widthMm: 68,
        heightMm: 19,
        materials: [
          {
            name: "ABS plastic housing",
            ipRatingCapable: "IP54",
            tempMinC: -30,
            tempMaxC: 80,
          },
          {
            name: "EPDM gasket",
            ipRatingCapable: "IP68",
            tempMinC: -40,
            tempMaxC: 120,
          },
        ],
        estimatedUnitCostUsd: 16.5,
        certificationStatus: { CE: "in-progress", FCC: "planned", RoHS: "certified" },
        dropTestHeightM: 1.2,
      },
    },
  },
  {
    name: "estimateProductWeight",
    description:
      "Aggregates per-component masses to compute total product and shipping weight. " +
      "Identifies the heaviest contributors, breaks down mass by functional category, and " +
      "checks the result against an optional weight budget.",
    dangerous: false,
    idempotent: true,
    costHint: "free",
    inputSchema: toJsonSchema(EstimateProductWeightInputSchema),
    outputSchema: toJsonSchema(EstimateProductWeightOutputSchema),
    exampleInput: {
      components: [
        { id: "mcu-stm32", name: "STM32L4 MCU", quantity: 1, massGrams: 1.2, category: "pcb" },
        {
          id: "abs-enclosure",
          name: "ABS enclosure",
          quantity: 1,
          massGrams: 45,
          category: "structural",
        },
        {
          id: "lipo-battery",
          name: "LiPo 1000 mAh",
          quantity: 1,
          massGrams: 22,
          category: "battery",
        },
        {
          id: "pcb-main",
          name: "Main PCB",
          quantity: 1,
          massGrams: 18,
          category: "pcb",
        },
        {
          id: "m3-screw",
          name: "M3×6 stainless screw",
          quantity: 6,
          massGrams: 0.9,
          category: "fastener",
        },
      ],
      packagingMassGrams: 85,
      targetMaxWeightGrams: 150,
    },
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
    exampleInput: {
      code: "const nums = [1, 2, 3, 4, 5];\nconst sum = nums.reduce((a, b) => a + b, 0);\nconsole.log('Sum:', sum);",
    },
  },
] as const;

/** Look up a tool definition by name. Returns undefined if not found. */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
