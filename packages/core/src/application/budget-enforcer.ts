import type { Budget, BudgetExceeded, BudgetExceededReason } from "@harness/contracts";
import type { BudgetUsage } from "../domain/workflow-state.js";

/**
 * BudgetEnforcer — checks four independent budget counters and reports
 * which limit (if any) has been exceeded.
 *
 * exceeded() returns the reason as structured data, not a boolean, so the
 * caller can embed a human-readable explanation in the workflow.failed event
 * and let the inspector show users exactly why the run was halted.
 *
 * Checks are evaluated in order of cost impact (tokens → steps → time → money).
 * Only the first exceeded limit is returned; the rest are checked on next invocation.
 */
export class BudgetEnforcer {
  constructor(private readonly budget: Budget) {}

  /**
   * Check whether any budget limit has been exceeded.
   * Returns the first exceeded limit, or null if all budgets are within limits.
   */
  check(usage: BudgetUsage): BudgetExceeded | null {
    const checks: Array<[BudgetExceededReason, number, number]> = [
      ["tokens", this.budget.maxTokens, usage.tokensUsed],
      ["steps", this.budget.maxSteps, usage.stepsCompleted],
      ["wallClock", this.budget.maxWallClockMs, usage.wallClockMs],
      ["costUsd", this.budget.maxCostUsd, usage.costUsd],
    ];

    for (const [reason, limit, actual] of checks) {
      if (actual >= limit) {
        return { reason, limit, actual };
      }
    }
    return null;
  }
}
