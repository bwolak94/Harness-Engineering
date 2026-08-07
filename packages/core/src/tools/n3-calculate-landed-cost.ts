import type { ToolDefinition } from "@harness/contracts";
import { HS_TARIFF_TABLE, lookupTariff } from "@harness/contracts/data/tariffs";
import type { TariffEntry } from "@harness/contracts/data/tariffs";
import {
  type CalculateLandedCostInput,
  CalculateLandedCostInputSchema,
  type CalculateLandedCostOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// TariffCondition — Specification pattern for composable tariff rules
//
// Each TariffCondition is a boolean predicate over a tariff evaluation context.
// Conditions compose via .and() / .or() / .not(), keeping policy declarations
// declarative and testable in isolation.
// ---------------------------------------------------------------------------

interface TariffContext {
  readonly input: CalculateLandedCostInput;
  readonly entry: TariffEntry;
}

interface TariffCondition {
  test(ctx: TariffContext): boolean;
  and(other: TariffCondition): TariffCondition;
  or(other: TariffCondition): TariffCondition;
  not(): TariffCondition;
}

class TariffConditionImpl implements TariffCondition {
  constructor(private readonly fn: (ctx: TariffContext) => boolean) {}

  test(ctx: TariffContext): boolean {
    return this.fn(ctx);
  }

  and(other: TariffCondition): TariffCondition {
    return new TariffConditionImpl((ctx) => this.test(ctx) && other.test(ctx));
  }

  or(other: TariffCondition): TariffCondition {
    return new TariffConditionImpl((ctx) => this.test(ctx) || other.test(ctx));
  }

  not(): TariffCondition {
    return new TariffConditionImpl((ctx) => !this.test(ctx));
  }
}

function condition(fn: (ctx: TariffContext) => boolean): TariffCondition {
  return new TariffConditionImpl(fn);
}

// Built-in conditions
const isPreferentialOrigin = condition(({ input }) => input.preferentialOrigin);
const hasPreferentialRate = condition(({ entry }) => entry.preferentialRatePct < entry.dutyRatePct);
const hasExcise = condition(({ entry }) => entry.excisePct > 0);
// Preferential treatment applies only when both the goods qualify AND the rate differs
const appliesPreferentialRate = isPreferentialOrigin.and(hasPreferentialRate);

// Incoterms where the declared value already includes freight (cost included in CIF value)
const FREIGHT_INCLUDED_INCOTERMS = new Set(["CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]);

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCalculateLandedCostTool(
  definition: ToolDefinition,
): Tool<CalculateLandedCostInput, CalculateLandedCostOutput> {
  return {
    definition,
    inputSchema: CalculateLandedCostInputSchema,

    async execute(input) {
      const entry = lookupTariff(input.hsCode);
      const chapter = input.hsCode.slice(0, 2);

      if (!entry) {
        const available = HS_TARIFF_TABLE.map((e) => `${e.hsChapter} (${e.description})`).join(
          ", ",
        );
        throw new Error(
          `HS code '${input.hsCode}' (chapter '${chapter}') not found in tariff table. Available chapters: ${available}. Verify the HS code and use a supported chapter, or contact customs authority for unlisted codes.`,
        );
      }

      const ctx: TariffContext = { input, entry };
      const appliedRules: string[] = [];

      // --- Customs value (CIF basis) ---
      const freightIncluded = FREIGHT_INCLUDED_INCOTERMS.has(input.incoterm);
      const customsValue = freightIncluded ? input.value : input.value + input.freightCost;
      appliedRules.push(
        freightIncluded
          ? `Incoterm ${input.incoterm}: freight already included in declared value; customs value = ${customsValue.toFixed(2)} ${input.currency}`
          : `Incoterm ${input.incoterm}: freight added to declared value; customs value = ${input.value.toFixed(2)} + ${input.freightCost.toFixed(2)} = ${customsValue.toFixed(2)} ${input.currency}`,
      );

      // --- HS chapter matched ---
      appliedRules.push(
        `HS chapter ${entry.hsChapter}: "${entry.description}" matched from code '${input.hsCode}'`,
      );

      // --- Duty rate (preferential vs standard) ---
      let dutyRatePct: number;
      if (appliesPreferentialRate.test(ctx)) {
        dutyRatePct = entry.preferentialRatePct;
        appliedRules.push(
          `Preferential origin (preferentialOrigin=true): duty rate ${entry.preferentialRatePct}% (standard ${entry.dutyRatePct}%)`,
        );
      } else if (isPreferentialOrigin.test(ctx) && !hasPreferentialRate.test(ctx)) {
        dutyRatePct = entry.dutyRatePct;
        appliedRules.push(
          `Preferential origin declared but no reduced rate for chapter ${entry.hsChapter}; standard duty ${entry.dutyRatePct}% applies`,
        );
      } else {
        dutyRatePct = entry.dutyRatePct;
        appliedRules.push(`Standard duty rate: ${entry.dutyRatePct}%`);
      }

      const duty = customsValue * (dutyRatePct / 100);
      appliedRules.push(
        `Duty = ${customsValue.toFixed(2)} × ${dutyRatePct}% = ${duty.toFixed(2)} ${input.currency}`,
      );

      // --- Excise ---
      let excise = 0;
      if (hasExcise.test(ctx)) {
        excise = customsValue * (entry.excisePct / 100);
        appliedRules.push(
          `Excise duty: ${entry.excisePct}% on customs value = ${excise.toFixed(2)} ${input.currency}`,
        );
      } else {
        appliedRules.push(`No excise duty for chapter ${entry.hsChapter}`);
      }

      // --- VAT ---
      const vatRatePct = entry.vatByCountry[input.destCountry];
      let vat = 0;
      if (vatRatePct !== undefined) {
        // VAT base = customs value + duty + excise
        const vatBase = customsValue + duty + excise;
        vat = vatBase * (vatRatePct / 100);
        appliedRules.push(
          `VAT (${input.destCountry}): ${vatRatePct}% on (customs value + duty + excise) = ${vatBase.toFixed(2)} × ${vatRatePct}% = ${vat.toFixed(2)} ${input.currency}`,
        );
      } else {
        appliedRules.push(
          `VAT rate for destination country '${input.destCountry}' not in table; VAT = 0. ` +
            `Known countries: ${Object.keys(entry.vatByCountry).join(", ")}.`,
        );
      }

      // --- Freight (always added to total landed cost) ---
      const freight = input.freightCost;
      if (freight > 0) {
        appliedRules.push(`Freight cost added to total: ${freight.toFixed(2)} ${input.currency}`);
      }

      const total = duty + vat + excise + freight;
      const effectiveRate = input.value > 0 ? (duty / input.value) * 100 : 0;
      appliedRules.push(
        `Total landed cost: duty ${duty.toFixed(2)} + VAT ${vat.toFixed(2)} + excise ${excise.toFixed(2)} + freight ${freight.toFixed(2)} = ${total.toFixed(2)} ${input.currency}`,
      );
      appliedRules.push(`Effective duty rate: ${effectiveRate.toFixed(2)}% of declared value`);

      return { duty, vat, excise, freight, total, effectiveRate, appliedRules };
    },
  };
}
