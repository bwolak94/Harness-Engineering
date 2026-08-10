import type { EvalCase } from "../types.js";
import { N1_CASES } from "./n1.js";
import { N2_CASES } from "./n2.js";
import { N3_CASES } from "./n3.js";
import { N4_CASES } from "./n4.js";
import { N5_CASES } from "./n5.js";
import { N6_CASES } from "./n6.js";
import { N7_CASES } from "./n7.js";
import { N8_CASES } from "./n8.js";
import { N9_CASES } from "./n9.js";
import { N10_CASES } from "./n10.js";
import { REGRESSION_CASES } from "./regression.js";

/**
 * All golden eval cases.
 *
 * Coverage:
 *   N1  analyzeInvestment   3 cases  (deterministic financial math)
 *   N2  optimizeRoute       2 cases  (TSP heuristic — structural checks)
 *   N3  calculateLandedCost 3 cases  (customs Specification pattern)
 *   N4  backtestRules       3 cases  (seeded PRNG candles, indicator engine)
 *   N5  assessClaim         3 cases  (deductible + depreciation + underinsurance)
 *   N6  screenCandidates    3 cases  (weighted rubric scoring, fan-out via Supervisor)
 *   N7  explodeRecipeCost   3 cases  (recursive BOM explosion, stock diff)
 *   N8  simulatePVPayback   2 cases  (8760-step solar simulation)
 *   N9  calculateNetSalary  3 cases  (versioned Polish payroll tables)
 *   N10 proposeRepricing    2 cases  (elasticity + margin floor)
 *   regression              2 cases  (budget guard + event sequence sanity)
 *   ─────────────────────────────────
 *   Total                  29 cases
 */
export const ALL_CASES: EvalCase[] = [
  ...N1_CASES,
  ...N2_CASES,
  ...N3_CASES,
  ...N4_CASES,
  ...N5_CASES,
  ...N6_CASES,
  ...N7_CASES,
  ...N8_CASES,
  ...N9_CASES,
  ...N10_CASES,
  ...REGRESSION_CASES,
];

export {
  N1_CASES,
  N2_CASES,
  N3_CASES,
  N4_CASES,
  N5_CASES,
  N6_CASES,
  N7_CASES,
  N8_CASES,
  N9_CASES,
  N10_CASES,
  REGRESSION_CASES,
};
