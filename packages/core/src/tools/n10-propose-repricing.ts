import type { ToolDefinition } from "@harness/contracts";
import {
  type ProposeRepricingInput,
  ProposeRepricingInputSchema,
  type ProposeRepricingOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Pricing math helpers
// ---------------------------------------------------------------------------

/**
 * Revenue-maximising price under constant elasticity of demand.
 *
 * Derived from: MR = 0 at monopoly optimum where MC = cost.
 *   P* = cost × |e| / (|e| − 1)   (requires |e| > 1, i.e. elastic demand)
 *
 * For |e| ≤ 1 (inelastic) no finite revenue-maximising price exists —
 * caller should fall back to current price.
 */
function elasticityBasedPrice(cost: number, elasticity: number): number | null {
  const absE = Math.abs(elasticity);
  if (absE <= 1) return null; // inelastic: theory says raise price indefinitely
  return (cost * absE) / (absE - 1);
}

/** Minimum price that satisfies the margin floor. */
function marginFloorPrice(cost: number, minMarginPct: number): number {
  const marginFraction = minMarginPct / 100;
  if (marginFraction >= 1) return Number.POSITIVE_INFINITY; // margin floor of 100%+ is impossible
  return cost / (1 - marginFraction);
}

/** Margin % given cost and price. */
function marginPct(cost: number, price: number): number {
  return price > 0 ? ((price - cost) / price) * 100 : 0;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createProposeRepricingTool(
  definition: ToolDefinition,
): Tool<ProposeRepricingInput, ProposeRepricingOutput> {
  return {
    definition,
    inputSchema: ProposeRepricingInputSchema,

    async execute(input) {
      const proposed: ProposeRepricingOutput["proposed"] = [];
      const blocked: ProposeRepricingOutput["blocked"] = [];

      // Index competitor prices by SKU for O(1) lookup
      const competitorsBySku = new Map<string, number[]>();
      for (const cp of input.competitorPrices) {
        const existing = competitorsBySku.get(cp.sku);
        if (existing) {
          existing.push(cp.price);
        } else {
          competitorsBySku.set(cp.sku, [cp.price]);
        }
      }

      const now = Date.now();

      for (const product of input.products) {
        const { sku, cost, currentPrice, lastChangeAt } = product;

        // --- Cooldown check ---
        const lastChangedMs = new Date(lastChangeAt).getTime();
        const cooldownMs = input.cooldownHours * 60 * 60 * 1000;
        if (now - lastChangedMs < cooldownMs) {
          const remainingHours = ((cooldownMs - (now - lastChangedMs)) / 3600000).toFixed(1);
          blocked.push({
            sku,
            reason: `Cooldown active: last change at ${lastChangeAt}, ${remainingHours}h remaining before next allowed change (cooldown = ${input.cooldownHours}h)`,
          });
          continue;
        }

        // --- Elasticity-based reference price ---
        const ePrice = elasticityBasedPrice(cost, input.elasticity);
        const elasticityRef = ePrice ?? currentPrice;

        // --- Competitor-informed target ---
        const competitorPrices = competitorsBySku.get(sku) ?? [];
        let candidatePrice: number;
        let rationale: string;

        if (competitorPrices.length > 0) {
          const avgCompetitor =
            competitorPrices.reduce((sum, p) => sum + p, 0) / competitorPrices.length;
          const minCompetitor = Math.min(...competitorPrices);

          // Target: 1 % undercut of the minimum competitor price, anchored at elasticity price
          const competitorTarget = minCompetitor * 0.99;
          candidatePrice = Math.max(elasticityRef, competitorTarget);
          rationale =
            `${competitorPrices.length} competitor price(s) found; min ${minCompetitor.toFixed(2)}, avg ${avgCompetitor.toFixed(2)}. ` +
            `Elasticity-based price: ${elasticityRef.toFixed(2)}. ` +
            `Targeting 1% below min competitor: ${competitorTarget.toFixed(2)}.`;
        } else {
          // No competitor data: rely on elasticity-based pricing
          candidatePrice = elasticityRef;
          rationale =
            ePrice !== null
              ? `No competitor data; elasticity (${input.elasticity}) suggests revenue-maximising price: ${ePrice.toFixed(2)}.`
              : `No competitor data; demand is inelastic (|e| ≤ 1); keeping current price ${currentPrice.toFixed(2)}.`;
        }

        // --- Margin floor ---
        const floorPrice = marginFloorPrice(cost, input.minMarginPct);
        if (candidatePrice < floorPrice) {
          candidatePrice = floorPrice;
          rationale += ` Margin floor (${input.minMarginPct}%) raised candidate to ${floorPrice.toFixed(2)}.`;
        }

        // --- Max daily change clamp ---
        const maxChange = currentPrice * (input.maxDailyChangePct / 100);
        const lowerBound = currentPrice - maxChange;
        const upperBound = currentPrice + maxChange;

        if (candidatePrice < lowerBound) {
          candidatePrice = lowerBound;
          rationale += ` Max daily change cap (${input.maxDailyChangePct}%) floored candidate to ${lowerBound.toFixed(2)}.`;
        } else if (candidatePrice > upperBound) {
          candidatePrice = upperBound;
          rationale += ` Max daily change cap (${input.maxDailyChangePct}%) capped candidate to ${upperBound.toFixed(2)}.`;
        }

        // --- Final margin check after all clamping ---
        const finalMargin = marginPct(cost, candidatePrice);
        if (finalMargin < input.minMarginPct) {
          blocked.push({
            sku,
            reason:
              `Cannot satisfy ${input.minMarginPct}% margin floor after applying daily change cap. ` +
              `Best achievable price ${candidatePrice.toFixed(2)} yields margin ${finalMargin.toFixed(1)}% with cost ${cost.toFixed(2)}.`,
          });
          continue;
        }

        rationale += ` Final price: ${candidatePrice.toFixed(2)}, expected margin: ${finalMargin.toFixed(1)}%.`;

        proposed.push({
          sku,
          newPrice: Math.round(candidatePrice * 100) / 100, // round to 2 decimal places
          expectedMarginPct: Math.round(finalMargin * 100) / 100,
          rationale,
        });
      }

      return { proposed, blocked };
    },
  };
}
