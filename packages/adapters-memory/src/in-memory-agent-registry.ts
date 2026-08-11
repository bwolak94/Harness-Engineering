import type { AgentRegistryPort, AgentSpec } from "@harness/core";

// ---------------------------------------------------------------------------
// InMemoryAgentRegistry
// ---------------------------------------------------------------------------

/**
 * InMemoryAgentRegistry — simple map-backed implementation of AgentRegistryPort.
 * Used in tests and local dev. Production composition root may use the same
 * implementation with a different set of agents.
 */
export class InMemoryAgentRegistry implements AgentRegistryPort {
  private readonly agents: ReadonlyMap<string, AgentSpec>;

  constructor(specs: readonly AgentSpec[]) {
    this.agents = new Map(specs.map((s) => [s.name, s]));
  }

  get(name: string): AgentSpec | undefined {
    return this.agents.get(name);
  }

  list(): readonly AgentSpec[] {
    return [...this.agents.values()];
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_AGENTS — three domain specialists (T10)
//
// Tool assignment follows the plan.md routing table:
//   financial-analyst  → N1 analyzeInvestment, N9 calculateNetSalary
//   operational-analyst→ N2 optimizeRoute, N7 explodeRecipeCost, N8 simulatePVPayback
//   commercial-analyst → N3 calculateLandedCost, N10 proposeRepricing
//
// N11 applyRepricing is intentionally excluded — it is dangerous and requires
// its own approval path (T12). A commercial analyst may propose; only an
// authorised actor may apply.
// ---------------------------------------------------------------------------

export const FINANCIAL_ANALYST: AgentSpec = {
  name: "financial-analyst",
  description:
    "Analyses real estate and business investments: IRR, NPV, DSCR, cap rates, cash flows. " +
    "Also calculates net salary breakdowns for Polish employment contracts.",
  toolNames: ["analyzeInvestment", "calculateNetSalary"],
};

export const OPERATIONAL_ANALYST: AgentSpec = {
  name: "operational-analyst",
  description:
    "Optimises delivery routes, explodes recipe costs (BOM), and simulates photovoltaic " +
    "payback periods including hourly irradiation models.",
  toolNames: ["optimizeRoute", "explodeRecipeCost", "simulatePVPayback"],
};

export const COMMERCIAL_ANALYST: AgentSpec = {
  name: "commercial-analyst",
  description:
    "Calculates landed cost for international trade (HS codes, duties, VAT) and proposes " +
    "dynamic repricing strategies based on elasticity and competitor prices.",
  toolNames: ["calculateLandedCost", "proposeRepricing"],
};

export const HOSPITALITY_ANALYST: AgentSpec = {
  name: "hospitality-analyst",
  description:
    "Finds hotels, hostels, and guest houses near a given location using OpenStreetMap data. " +
    "Analyses each property's amenities, star rating, public transit accessibility, and " +
    "surrounding neighbourhood to produce a structured comparison with pros/cons and a recommendation.",
  toolNames: ["searchHotels"],
};

export const DEFAULT_AGENTS: readonly AgentSpec[] = [
  FINANCIAL_ANALYST,
  OPERATIONAL_ANALYST,
  COMMERCIAL_ANALYST,
  HOSPITALITY_ANALYST,
];

// ---------------------------------------------------------------------------
// DEFAULT_RULES — keyword sets for RuleBasedClassifier
//
// Each keyword is a lowercase substring matched against the lowercased intent.
// Scoring: confidence = matches_for_best_agent / total_matches_across_all_agents.
// A single unambiguous hit (all matches belong to one agent) yields 1.0.
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "hospitality-analyst",
    [
      "hotel",
      "hotels",
      "hostel",
      "motel",
      "accommodation",
      "stay",
      "lodging",
      "bed and breakfast",
      "guest house",
      "where to sleep",
      "where to stay",
      "book a room",
      "nearby hotels",
      "hotels near",
      "find hotels",
    ],
  ],
  [
    "financial-analyst",
    [
      "invest",
      "irr",
      "npv",
      "dscr",
      "cap rate",
      "cash flow",
      "loan",
      "rent",
      "rental",
      "portfolio",
      "salary",
      "net pay",
      "gross",
      "tax relief",
      "zus",
      "pit",
      "b2b",
      "zlecenie",
    ],
  ],
  [
    "operational-analyst",
    [
      "route",
      "routing",
      "delivery",
      "logistics",
      "depot",
      "stops",
      "recipe",
      "bom",
      "ingredient",
      "solar",
      "pv",
      "photovoltaic",
      "energy",
      "payback",
      "kwh",
      "tariff zone",
    ],
  ],
  [
    "commercial-analyst",
    [
      "import",
      "hs code",
      "tariff",
      "duty",
      "landed cost",
      "incoterm",
      "vat",
      "excise",
      "repricing",
      "sku",
      "margin",
      "elasticity",
      "competitor price",
      "pricing",
    ],
  ],
]);
