// Evaluation harness — golden set, deterministic assertions, trajectory regression.
export type {
  EvalCase,
  EvalResult,
  EvalReport,
  OutcomeCheck,
  TrajectoryConstraint,
} from "./types.js";
export { EvalRunner } from "./runner.js";
export { buildReport, toJson, toMarkdown, writeReports } from "./report.js";
export {
  ALL_CASES,
  N1_CASES,
  N2_CASES,
  N3_CASES,
  N5_CASES,
  N8_CASES,
  N9_CASES,
  N10_CASES,
  REGRESSION_CASES,
} from "./golden/index.js";
export { runOutcomeCheck, runTrajectoryCheck, getNestedValue } from "./judge.js";
export { saveSnapshot, loadSnapshot, diffSnapshots, toEventTypeSequence } from "./snapshot.js";
