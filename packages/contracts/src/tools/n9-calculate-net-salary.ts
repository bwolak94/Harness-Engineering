import { z } from "zod";

export const ContractTypeSchema = z
  .enum(["uop", "zlecenie", "b2b"])
  .describe("uop=employment contract, zlecenie=civil contract, b2b=self-employment");

export const TaxReliefSchema = z.object({
  type: z.enum([
    "middle_class_relief",
    "child_relief",
    "pensioner_zero_tax",
    "young_person_zero_tax",
    "return_from_abroad",
  ]),
  monthlyAmount: z.number().nonnegative().optional(),
});

export const CalculateNetSalaryInputSchema = z.object({
  gross: z.number().positive().describe("Gross monthly salary in PLN"),
  contractType: ContractTypeSchema,
  year: z
    .number()
    .int()
    .min(2022)
    .max(2030)
    .describe("Tax year — rates come from versioned data tables"),
  taxReliefs: z.array(TaxReliefSchema).default([]),
  ppkRate: z
    .number()
    .min(0)
    .max(4)
    .default(2)
    .describe("Employee PPK contribution % (0 = opted out)"),
  jointFiling: z
    .boolean()
    .default(false)
    .describe("True if filing jointly with a non-earning spouse (halves tax base)"),
});

export const CalculateNetSalaryOutputSchema = z.object({
  net: z.number().nonnegative().describe("Take-home pay"),
  zusEmployee: z.number().nonnegative().describe("Total employee ZUS contributions"),
  zusEmployer: z.number().nonnegative().describe("Total employer ZUS contributions"),
  health: z.number().nonnegative().describe("Health insurance contribution"),
  deductibleCosts: z.number().nonnegative().describe("Tax-deductible costs applied"),
  advanceTax: z.number().nonnegative().describe("Monthly income tax advance"),
  employerTotalCost: z.number().nonnegative().describe("Total cost to employer"),
  appliedThresholds: z
    .array(z.string())
    .describe("Description of tax thresholds and limits applied (audit trail)"),
});

export type CalculateNetSalaryInput = z.infer<typeof CalculateNetSalaryInputSchema>;
export type CalculateNetSalaryOutput = z.infer<typeof CalculateNetSalaryOutputSchema>;
