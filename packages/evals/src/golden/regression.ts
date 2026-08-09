import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * Trajectory regression cases.
 *
 * These cases do NOT assert on tool outputs — they assert on the SHAPE of the
 * execution trajectory. Their primary purpose is to detect unintentional
 * regressions in runtime safety mechanisms:
 *
 *  1. budget-guard — workflow must fail with workflow.failed when budget is
 *     exhausted. If BudgetEnforcer is removed the model loops indefinitely.
 *     Detectable because: snapshot shows `workflow.failed`, any post-removal
 *     run would produce more events (or complete instead of failing).
 *
 *  2. loop-detection-corrective — the LoopDetector injects a corrective
 *     message after repeated identical calls. With FakeModelPort this does
 *     not change the event sequence directly, but the max_steps trajectory
 *     constraint catches the case where the workflow runs more steps than
 *     expected (which would happen if the model actually responds to the
 *     corrective message but the budget limit is lower than the repeat count).
 *
 * How to prove regression detection works:
 *   Run `pnpm eval` on an unmodified codebase — all cases pass.
 *   Comment out BudgetEnforcer.check() in harness-runtime.ts.
 *   Run `pnpm eval` again — budget-guard snapshot mismatches (more events).
 */
export const REGRESSION_CASES: EvalCase[] = [
  {
    id: "regression-budget-guard",
    tool: "analyzeInvestment",
    description:
      "Budget guard: maxSteps=2 with scripted loop — workflow.failed must appear in events when steps exhausted",
    task: {
      id: "eval-regression-budget",
      goal: "Keep analyzing investments until I say stop.",
      // Tight budget: only 2 steps allowed
      budget: { maxTokens: 50_000, maxSteps: 2, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    // FakeModelPort repeatedly calls the same tool — budget guard must stop it after maxSteps
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 300_000,
        rentRoll: [{ unit: "u1", monthlyRent: 1_200, occupancyPct: 90 }],
        opex: [],
        loan: { amount: 200_000, rateAnnualPct: 4, termYears: 20, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.07,
      }),
      // Second identical call — if budget is not enforced this would run
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 300_000,
        rentRoll: [{ unit: "u1", monthlyRent: 1_200, occupancyPct: 90 }],
        opex: [],
        loan: { amount: 200_000, rateAnnualPct: 4, termYears: 20, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.07,
      }),
      // Third call — would only run if budget guard is missing
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 300_000,
        rentRoll: [{ unit: "u1", monthlyRent: 1_200, occupancyPct: 90 }],
        opex: [],
        loan: { amount: 200_000, rateAnnualPct: 4, termYears: 20, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.07,
      }),
      FakeModelPort.textResponse("Done"),
    ]),
    outcomeChecks: [],
    trajectoryChecks: [
      // Budget guard fires after maxSteps=2 — reducer sets status "halted" when
      // workflow.failed event has budgetExceeded payload (see reducer.ts).
      { type: "status", expected: "halted" },
      // Exactly 2 steps must have run (not 3 or more)
      { type: "max_steps", max: 2 },
    ],
    // Snapshot captures: workflow.started → 2×(context.hydrated + step.planned + tool.called
    // + tool.succeeded + state.checkpointed) → context.hydrated → workflow.failed
    // Removing the budget guard would produce 3+ tool calls instead of 2 → snapshot mismatch
    snapshot: true,
  },

  {
    id: "regression-single-step-completes",
    tool: "analyzeInvestment",
    description:
      "Sanity: single tool call + final text response → workflow.completed, exactly 1 step",
    task: {
      id: "eval-regression-single",
      goal: "Analyze this property quickly.",
      budget: { maxTokens: 10_000, maxSteps: 10, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 400_000,
        rentRoll: [{ unit: "u1", monthlyRent: 1_800, occupancyPct: 92 }],
        opex: [],
        loan: { amount: 300_000, rateAnnualPct: 5, termYears: 20, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.065,
      }),
      FakeModelPort.textResponse("Analysis complete."),
    ]),
    outcomeChecks: [{ type: "field_gt", path: "noi", value: 0 }],
    trajectoryChecks: [
      { type: "status", expected: "completed" },
      { type: "min_steps", min: 1 },
      { type: "max_steps", max: 1 },
    ],
    // This snapshot serves as the "gold standard" for a clean single-step run.
    // Any change to the event emission order in middleware.ts breaks this.
    snapshot: true,
  },
];
