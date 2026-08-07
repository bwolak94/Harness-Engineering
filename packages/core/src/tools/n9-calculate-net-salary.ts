import type { ToolDefinition } from "@harness/contracts";
import { type PitRates, type ZusRates, getSalaryRates } from "@harness/contracts/data/salary-rates";
import {
  type CalculateNetSalaryInput,
  CalculateNetSalaryInputSchema,
  type CalculateNetSalaryOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Internal calculation helpers
// ---------------------------------------------------------------------------

interface ZusSplit {
  pensionEmployee: number;
  disabilityEmployee: number;
  sickness: number;
  total: number;
}

interface ZusEmployerSplit {
  pensionEmployer: number;
  disabilityEmployer: number;
  accident: number;
  fp: number;
  fgsp: number;
  total: number;
}

function calcZusEmployee(gross: number, zus: ZusRates): ZusSplit {
  const pensionEmployee = gross * zus.pensionEmployee;
  const disabilityEmployee = gross * zus.disabilityEmployee;
  const sickness = gross * zus.sickness;
  return {
    pensionEmployee,
    disabilityEmployee,
    sickness,
    total: pensionEmployee + disabilityEmployee + sickness,
  };
}

function calcZusEmployer(gross: number, zus: ZusRates): ZusEmployerSplit {
  const pensionEmployer = gross * zus.pensionEmployer;
  const disabilityEmployer = gross * zus.disabilityEmployer;
  const accident = gross * zus.accident;
  const fp = gross * zus.fp;
  const fgsp = gross * zus.fgsp;
  return {
    pensionEmployer,
    disabilityEmployer,
    accident,
    fp,
    fgsp,
    total: pensionEmployer + disabilityEmployer + accident + fp + fgsp,
  };
}

/**
 * Calculate monthly income tax advance for UoP / zlecenie.
 *
 * Annualises the monthly tax base, applies thresholds, divides by 12.
 * Joint filing halves the tax base before applying rates, then doubles the result.
 */
function calcAdvanceTax(
  monthlyTaxBase: number,
  pit: PitRates,
  jointFiling: boolean,
  thresholds: string[],
): number {
  let annualBase = Math.max(0, monthlyTaxBase * 12);

  if (jointFiling) {
    annualBase /= 2;
    thresholds.push("Joint filing: tax base halved before threshold calculation");
  }

  const taxableBase = Math.max(0, annualBase - pit.taxFreeAmount);
  thresholds.push(
    `Tax-free amount: ${pit.taxFreeAmount} PLN/year; taxable annual base = ${taxableBase.toFixed(2)} PLN`,
  );

  let annualTax: number;
  if (taxableBase <= pit.threshold1Amount) {
    annualTax = taxableBase * (pit.rate1Pct / 100);
    thresholds.push(
      `First threshold (≤ ${pit.threshold1Amount} PLN): rate ${pit.rate1Pct}%; annual tax = ${annualTax.toFixed(2)} PLN`,
    );
  } else {
    const tier1Tax = pit.threshold1Amount * (pit.rate1Pct / 100);
    const tier2Tax = (taxableBase - pit.threshold1Amount) * (pit.rate2Pct / 100);
    annualTax = tier1Tax + tier2Tax;
    thresholds.push(
      `Second threshold (> ${pit.threshold1Amount} PLN): ${pit.rate1Pct}% on first ${pit.threshold1Amount} PLN + ${pit.rate2Pct}% on remainder; annual tax = ${annualTax.toFixed(2)} PLN`,
    );
  }

  if (jointFiling) {
    annualTax *= 2;
    thresholds.push(
      `Joint filing: annual tax doubled after threshold calculation = ${annualTax.toFixed(2)} PLN`,
    );
  }

  return Math.max(0, annualTax / 12);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCalculateNetSalaryTool(
  definition: ToolDefinition,
): Tool<CalculateNetSalaryInput, CalculateNetSalaryOutput> {
  return {
    definition,
    inputSchema: CalculateNetSalaryInputSchema,

    async execute(input) {
      const appliedThresholds: string[] = [];

      const rates = getSalaryRates(input.year);
      if (!rates) {
        const available = [2023, 2024, 2025].join(", ");
        throw new Error(
          `Salary rates for year ${input.year} are not in the table. Available years: ${available}. To add a new year, update packages/contracts/src/data/salary-rates.ts.`,
        );
      }

      appliedThresholds.push(
        `Year ${input.year}: rates loaded (minimum wage ${rates.minimumWage} PLN, ZUS pension employee ${rates.zus.pensionEmployee * 100}%)`,
      );
      appliedThresholds.push(`Contract type: ${input.contractType}`);

      const { gross } = input;
      const { zus: zusRates, pit } = rates;

      // PPK employer: standard 1.5 % (constant across years in current regulations)
      const PPK_EMPLOYER_RATE = 0.015;
      const ppkEmployee = gross * (input.ppkRate / 100);
      const ppkEmployer = gross * PPK_EMPLOYER_RATE;

      if (input.ppkRate > 0) {
        appliedThresholds.push(
          `PPK: employee ${input.ppkRate}% = ${ppkEmployee.toFixed(2)} PLN, employer ${PPK_EMPLOYER_RATE * 100}% = ${ppkEmployer.toFixed(2)} PLN`,
        );
      } else {
        appliedThresholds.push("PPK: opted out (ppkRate = 0)");
      }

      if (input.contractType === "uop" || input.contractType === "zlecenie") {
        // --- Employee ZUS ---
        const zusEmp = calcZusEmployee(gross, zusRates);
        appliedThresholds.push(
          `ZUS employee: pension ${zusEmp.pensionEmployee.toFixed(2)} + disability ${zusEmp.disabilityEmployee.toFixed(2)} + sickness ${zusEmp.sickness.toFixed(2)} = ${zusEmp.total.toFixed(2)} PLN`,
        );
        appliedThresholds.push(
          `Note: ZUS contribution base cap (${zusRates.limitMultiple}× projected average wage) not applied in this simplified calculator.`,
        );

        // --- Health ---
        const healthBase = gross - zusEmp.total;
        const health = healthBase * (pit.healthContributionRatePct / 100);
        appliedThresholds.push(
          `Health: ${pit.healthContributionRatePct}% × (gross − ZUS) = ${pit.healthContributionRatePct}% × ${healthBase.toFixed(2)} = ${health.toFixed(2)} PLN`,
        );
        if (pit.healthDeductibleRatePct > 0) {
          appliedThresholds.push(
            `Health deductible from tax: ${pit.healthDeductibleRatePct}% (applicable to this year)`,
          );
        } else {
          appliedThresholds.push(
            "Health contribution is NOT deductible from income tax (2022+ rules)",
          );
        }

        // --- Deductible costs ---
        const deductibleCosts =
          input.contractType === "zlecenie"
            ? gross * 0.2 // civil contracts: 20 % of income
            : pit.deductibleCostsBasic;
        appliedThresholds.push(
          input.contractType === "zlecenie"
            ? `Deductible costs (zlecenie): 20% of gross = ${deductibleCosts.toFixed(2)} PLN`
            : `Deductible costs (UoP basic): ${deductibleCosts.toFixed(2)} PLN/month`,
        );

        // --- Tax advance ---
        const monthlyTaxBase = gross - zusEmp.total - deductibleCosts;
        const advanceTax = calcAdvanceTax(
          monthlyTaxBase,
          pit,
          input.jointFiling,
          appliedThresholds,
        );

        // Apply tax reliefs (simplified)
        let finalAdvanceTax = advanceTax;
        for (const relief of input.taxReliefs) {
          if (relief.type === "young_person_zero_tax") {
            finalAdvanceTax = 0;
            appliedThresholds.push(
              "Relief applied: young_person_zero_tax — income tax advance = 0 (applies up to annual limit, not enforced here)",
            );
          } else if (relief.type === "pensioner_zero_tax") {
            finalAdvanceTax = 0;
            appliedThresholds.push(
              "Relief applied: pensioner_zero_tax — income tax advance = 0 (applies up to annual limit)",
            );
          } else if (relief.type === "child_relief" && relief.monthlyAmount !== undefined) {
            finalAdvanceTax = Math.max(0, finalAdvanceTax - relief.monthlyAmount);
            appliedThresholds.push(
              `Relief applied: child_relief — monthly reduction ${relief.monthlyAmount} PLN; advance tax = ${finalAdvanceTax.toFixed(2)} PLN`,
            );
          } else {
            appliedThresholds.push(
              `Relief '${relief.type}' noted but not applied in this simplified calculator.`,
            );
          }
        }

        // --- Employer ZUS ---
        const zusEmpr = calcZusEmployer(gross, zusRates);
        appliedThresholds.push(
          `ZUS employer: pension ${zusEmpr.pensionEmployer.toFixed(2)} + disability ${zusEmpr.disabilityEmployer.toFixed(2)} + accident ${zusEmpr.accident.toFixed(2)} + FP ${zusEmpr.fp.toFixed(2)} + FGSP ${zusEmpr.fgsp.toFixed(2)} = ${zusEmpr.total.toFixed(2)} PLN`,
        );

        const net = gross - zusEmp.total - health - finalAdvanceTax - ppkEmployee;
        const employerTotalCost = gross + zusEmpr.total + ppkEmployer;

        return {
          net,
          zusEmployee: zusEmp.total,
          zusEmployer: zusEmpr.total,
          health,
          deductibleCosts,
          advanceTax: finalAdvanceTax,
          employerTotalCost,
          appliedThresholds,
        };
      }

      // --- B2B (self-employment) — simplified ---
      // ZUS "duży" (full ZUS): employee-side rates applied to gross as approximation.
      // In practice B2B ZUS is a flat amount based on 60% of projected average wage,
      // but the rates table does not include that figure.
      const zusEmpB2B = calcZusEmployee(gross, zusRates);
      appliedThresholds.push(
        "B2B simplified: ZUS calculated as percentage of gross (approximate; actual B2B ZUS is a flat monthly amount based on 60% of projected average wage)",
      );

      const healthB2B = (gross - zusEmpB2B.total) * (pit.healthContributionRatePct / 100);
      appliedThresholds.push(
        `B2B health: ${pit.healthContributionRatePct}% on income after ZUS = ${healthB2B.toFixed(2)} PLN (note: for flat-tax B2B, health rate is 4.9%)`,
      );

      const b2bTaxBase = gross - zusEmpB2B.total - pit.deductibleCostsBasic;
      const advanceTaxB2B = calcAdvanceTax(b2bTaxBase, pit, input.jointFiling, appliedThresholds);

      const netB2B = gross - zusEmpB2B.total - healthB2B - advanceTaxB2B - ppkEmployee;

      // B2B: no employer ZUS (self-employed pays own ZUS)
      const zusEmprB2B = calcZusEmployer(gross, zusRates);
      appliedThresholds.push(
        "B2B: employer ZUS components shown are the self-employed person's total ZUS burden (same rates applied for comparability)",
      );

      return {
        net: netB2B,
        zusEmployee: zusEmpB2B.total,
        zusEmployer: zusEmprB2B.total,
        health: healthB2B,
        deductibleCosts: pit.deductibleCostsBasic,
        advanceTax: advanceTaxB2B,
        employerTotalCost: gross + zusEmprB2B.total + ppkEmployer,
        appliedThresholds,
      };
    },
  };
}
