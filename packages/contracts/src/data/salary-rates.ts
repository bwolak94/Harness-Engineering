/**
 * Polish salary calculation rate tables for N9 (calculateNetSalary).
 * Versioned by year — adding a new year is a data change, not a code change.
 *
 * Sources: ZUS, MF, GUS official publications.
 * NOTE: For educational purposes only. Always verify with official sources.
 */

export interface ZusRates {
  pensionEmployee: number;
  pensionEmployer: number;
  disabilityEmployee: number;
  disabilityEmployer: number;
  sickness: number;
  accident: number;
  fp: number;
  fgsp: number;
  limitMultiple: number;
}

export interface PitRates {
  threshold1Amount: number;
  rate1Pct: number;
  threshold2Amount: number;
  rate2Pct: number;
  taxFreeAmount: number;
  deductibleCostsBasic: number;
  deductibleCostsCommuting: number;
  healthContributionRatePct: number;
  healthDeductibleRatePct: number;
}

export interface SalaryRates {
  year: number;
  zus: ZusRates;
  pit: PitRates;
  minimumWage: number;
}

export const SALARY_RATES_TABLE: readonly SalaryRates[] = [
  {
    year: 2023,
    zus: {
      pensionEmployee: 0.0976,
      pensionEmployer: 0.0976,
      disabilityEmployee: 0.015,
      disabilityEmployer: 0.065,
      sickness: 0.0245,
      accident: 0.0167,
      fp: 0.0245,
      fgsp: 0.001,
      limitMultiple: 30,
    },
    pit: {
      threshold1Amount: 120_000,
      rate1Pct: 12,
      threshold2Amount: Number.POSITIVE_INFINITY,
      rate2Pct: 32,
      taxFreeAmount: 30_000,
      deductibleCostsBasic: 250,
      deductibleCostsCommuting: 300,
      healthContributionRatePct: 9,
      healthDeductibleRatePct: 0,
    },
    minimumWage: 3490,
  },
  {
    year: 2024,
    zus: {
      pensionEmployee: 0.0976,
      pensionEmployer: 0.0976,
      disabilityEmployee: 0.015,
      disabilityEmployer: 0.065,
      sickness: 0.0245,
      accident: 0.0167,
      fp: 0.0245,
      fgsp: 0.001,
      limitMultiple: 30,
    },
    pit: {
      threshold1Amount: 120_000,
      rate1Pct: 12,
      threshold2Amount: Number.POSITIVE_INFINITY,
      rate2Pct: 32,
      taxFreeAmount: 30_000,
      deductibleCostsBasic: 250,
      deductibleCostsCommuting: 300,
      healthContributionRatePct: 9,
      healthDeductibleRatePct: 0,
    },
    minimumWage: 4242,
  },
  {
    year: 2025,
    zus: {
      pensionEmployee: 0.0976,
      pensionEmployer: 0.0976,
      disabilityEmployee: 0.015,
      disabilityEmployer: 0.065,
      sickness: 0.0245,
      accident: 0.0167,
      fp: 0.0245,
      fgsp: 0.001,
      limitMultiple: 30,
    },
    pit: {
      threshold1Amount: 120_000,
      rate1Pct: 12,
      threshold2Amount: Number.POSITIVE_INFINITY,
      rate2Pct: 32,
      taxFreeAmount: 30_000,
      deductibleCostsBasic: 250,
      deductibleCostsCommuting: 300,
      healthContributionRatePct: 9,
      healthDeductibleRatePct: 0,
    },
    minimumWage: 4666,
  },
];

/** Look up salary rates by year. Returns undefined if year is not in the table. */
export function getSalaryRates(year: number): SalaryRates | undefined {
  return SALARY_RATES_TABLE.find((r) => r.year === year);
}
