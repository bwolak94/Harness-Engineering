import type { FlowSpec } from "@harness/core";

// ---------------------------------------------------------------------------
// DEFAULT_FLOWS — four pre-wired business orchestration flows
//
// Pattern choice rationale:
//   parallel   → agents work on independent aspects; order does not matter.
//   sequential → each agent's output enriches the next agent's prompt.
//
// {{goal}} in goalTemplate is replaced with the user-provided goal string
// at runtime by the FlowRunner, so flows stay domain-agnostic.
// ---------------------------------------------------------------------------

/**
 * Supply Chain Audit — parallel
 *
 * Two analysts work simultaneously on the same shipment:
 * - commercial-analyst calculates total landed cost (duties, VAT, freight).
 * - operational-analyst optimises the onward delivery route.
 *
 * Reduces total analysis time vs sequential; outputs are independent.
 */
export const SUPPLY_CHAIN_AUDIT: FlowSpec = {
  id: "supply-chain-audit",
  name: "Supply Chain Audit",
  description:
    "Parallel analysis of landed cost (duties, VAT, freight) and delivery route optimisation " +
    "for an international shipment. Both analysts run simultaneously.",
  pattern: "parallel",
  steps: [
    {
      agentName: "commercial-analyst",
      goalTemplate:
        "You are the commercial analyst on a supply chain audit. " +
        "Calculate the full landed cost — HS code duties, VAT, excise, and freight — " +
        "and provide a breakdown of applied rules for audit purposes.\n\n{{goal}}",
    },
    {
      agentName: "operational-analyst",
      goalTemplate:
        "You are the operational analyst on a supply chain audit. " +
        "Optimise the delivery route from the receiving depot to all customer stops, " +
        "respecting time windows and vehicle capacity.\n\n{{goal}}",
    },
  ],
};

/**
 * Investment Due Diligence — sequential
 *
 * Two-step pipeline: first evaluate the property, then calculate the
 * investor's net take-home income. The second step receives the first
 * step's IRR/DSCR output as context so it can frame the salary in terms
 * of cash-flow coverage.
 */
export const INVESTMENT_DUE_DILIGENCE: FlowSpec = {
  id: "investment-due-diligence",
  name: "Investment Due Diligence",
  description:
    "Sequential pipeline: first run a full property investment analysis (IRR, NPV, DSCR, " +
    "cap rate, cash flows), then calculate the investor's net salary to assess " +
    "personal cash-flow coverage.",
  pattern: "sequential",
  steps: [
    {
      agentName: "financial-analyst",
      goalTemplate:
        "You are the financial analyst performing investment due diligence. " +
        "Run a full real-estate investment analysis: calculate NOI, cap rate, " +
        "cash-on-cash return, IRR, NPV, DSCR, and break-even occupancy. " +
        "Include cashflows[] and assumptions[] in your output.\n\n{{goal}}",
    },
    {
      agentName: "financial-analyst",
      goalTemplate:
        "You are the financial analyst completing investment due diligence. " +
        "The previous step has produced the property analysis. Now calculate the " +
        "investor's net salary or take-home income under their employment contract, " +
        "and summarise how their personal cash flow covers the investment DSCR requirements.\n\n{{goal}}",
    },
  ],
};

/**
 * Business Launch Assessment — parallel
 *
 * Three specialists analyse complementary aspects of launching a new
 * product or business simultaneously. The results arrive together and
 * can be read as a multi-dimensional launch readiness report.
 */
export const BUSINESS_LAUNCH_ASSESSMENT: FlowSpec = {
  id: "business-launch-assessment",
  name: "Business Launch Assessment",
  description:
    "Three-way parallel assessment for a new product launch: financial analyst sizes " +
    "the investment and salary cost, commercial analyst calculates import costs and " +
    "proposes initial pricing, operational analyst models production costs (recipe BOM).",
  pattern: "parallel",
  steps: [
    {
      agentName: "financial-analyst",
      goalTemplate:
        "You are the financial analyst in a business launch assessment. " +
        "Evaluate the investment case: estimate the initial capital requirement, " +
        "project a 5-year IRR, and calculate the founder's net salary under a B2B contract.\n\n{{goal}}",
    },
    {
      agentName: "commercial-analyst",
      goalTemplate:
        "You are the commercial analyst in a business launch assessment. " +
        "Calculate the total landed cost for importing the core product, " +
        "then propose initial pricing based on a 30% minimum margin and market elasticity.\n\n{{goal}}",
    },
    {
      agentName: "operational-analyst",
      goalTemplate:
        "You are the operational analyst in a business launch assessment. " +
        "Explode the bill of materials (recipe BOM) for the core product, " +
        "calculate unit production cost, and identify the top 3 cost drivers to target.\n\n{{goal}}",
    },
  ],
};

/**
 * Dynamic Pricing Pipeline — sequential
 *
 * Step 1: commercial-analyst calculates the true landed cost per SKU, which
 * becomes the cost-of-goods-sold floor for repricing.
 * Step 2: commercial-analyst proposes new prices using the landed cost,
 * competitor prices, and elasticity — so the margin floor reflects reality,
 * not accounting approximations.
 */
export const DYNAMIC_PRICING_PIPELINE: FlowSpec = {
  id: "dynamic-pricing-pipeline",
  name: "Dynamic Pricing Pipeline",
  description:
    "Sequential pipeline: first calculate true landed cost per SKU (duties, VAT, freight), " +
    "then propose optimal prices using the landed cost as the margin floor, " +
    "competitor prices, and demand elasticity.",
  pattern: "sequential",
  steps: [
    {
      agentName: "commercial-analyst",
      goalTemplate:
        "You are the commercial analyst in a pricing pipeline. " +
        "Calculate the full landed cost for each product SKU in the catalogue — " +
        "including HS code duties, VAT, excise, and freight allocation. " +
        "Output a cost-per-unit breakdown that will be used as the margin floor in the next step.\n\n{{goal}}",
    },
    {
      agentName: "commercial-analyst",
      goalTemplate:
        "You are the commercial analyst completing a dynamic pricing pipeline. " +
        "The previous step has calculated the true landed cost per SKU. " +
        "Using those costs as the margin floor, propose optimal prices for the catalogue " +
        "based on demand elasticity, competitor prices, and a minimum margin of 20%. " +
        "Respect the cooldown period — do not re-price SKUs changed within 24 hours.\n\n{{goal}}",
    },
  ],
};

/**
 * Hotel Analysis — sequential, 3 steps
 *
 * Step 1: hospitality-analyst uses searchHotels to fetch raw OSM data for
 *         the requested location — names, coordinates, stars, amenities,
 *         and nearby transit stops.
 *
 * Step 2: hospitality-analyst receives the raw data and analyses each hotel
 *         in depth: pros/cons, neighbourhood description, transit convenience,
 *         value-for-money estimate, and a ranked shortlist with reasoning.
 *
 * Step 3: operational-analyst takes the hotel shortlist and uses optimizeRoute
 *         to model the journey from the main station/airport to each candidate,
 *         adding a logistics accessibility score to the final recommendation.
 *
 * Genuine multi-agent: steps 1-2 are data collection + hospitality analysis;
 * step 3 is logistics/routing analysis by a different specialist.
 */
export const HOTEL_ANALYSIS: FlowSpec = {
  id: "hotel-analysis",
  name: "Hotel Analysis",
  description:
    "Three-step sequential analysis: (1) fetch hotels near a location from OpenStreetMap, " +
    "(2) analyse each hotel — pros/cons, amenities, transit, neighbourhood, " +
    "(3) operational analyst models routes from the main hub to the top candidates.",
  pattern: "sequential",
  steps: [
    {
      agentName: "hospitality-analyst",
      goalTemplate:
        "You are a hospitality analyst. Your first task is DATA COLLECTION. " +
        "Use the searchHotels tool to find all hotels, hostels, and guest houses near the requested location. " +
        "Return the COMPLETE raw result from the tool — all hotel names, coordinates, star ratings, " +
        "amenities, and nearby transit stops — without omitting any fields. " +
        "This raw data will be passed to the next analysis step.\n\n{{goal}}",
    },
    {
      agentName: "hospitality-analyst",
      goalTemplate:
        "You are a hospitality analyst. Your task is IN-DEPTH ANALYSIS. " +
        "The previous step has collected raw hotel data (provided below as context). " +
        "For each hotel in the data, produce a structured analysis:\n" +
        "  • Pros: what makes this hotel attractive (location, stars, amenities, transit)\n" +
        "  • Cons: what is missing or inconvenient\n" +
        "  • Neighbourhood: describe the area based on transit stop names and OSM tags\n" +
        "  • Transit score: rate public transport accessibility (1-5) based on nearbyTransit data\n" +
        "  • Value rating: estimate value-for-money given star rating and amenities (1-5)\n\n" +
        "End with a ranked TOP 3 shortlist with one sentence justification each.\n\n{{goal}}",
    },
    {
      agentName: "operational-analyst",
      goalTemplate:
        "You are an operational analyst. The previous steps have identified the best hotels near a location. " +
        "Your task is LOGISTICS ANALYSIS. " +
        "Using the hotel addresses and coordinates from the context, use the optimizeRoute tool to model " +
        "the most efficient route from the main railway station or airport in the area to the top hotel candidates. " +
        "Calculate estimated travel distances, provide a logistics accessibility ranking, " +
        "and flag any hotels that are difficult to reach without a car.\n\n{{goal}}",
    },
  ],
};

export const DEFAULT_FLOWS: readonly FlowSpec[] = [
  SUPPLY_CHAIN_AUDIT,
  INVESTMENT_DUE_DILIGENCE,
  BUSINESS_LAUNCH_ASSESSMENT,
  DYNAMIC_PRICING_PIPELINE,
  HOTEL_ANALYSIS,
];
