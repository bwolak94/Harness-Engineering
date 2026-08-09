import type { BudgetThresholdExceededEvent } from "@harness/contracts";
import type { HarnessMiddleware, ToolCallInput } from "@harness/core";

/**
 * withBudgetThreshold — HarnessMiddleware that emits budget.threshold.exceeded
 * events when accumulated cost or token usage crosses configured thresholds.
 *
 * The event is written directly to ctx.eventLog with the next available seq
 * and pushed to ctx.bag.emittedEvents so the runtime reduces it into state.
 *
 * Placement: inject BEFORE withTracing in the user middleware array so the
 * threshold event is emitted after every step (where state.budget is current):
 *
 *   middleware: [withBudgetThreshold(options), withTracing(tracer)]
 *
 * Design decisions:
 * - Does NOT halt the workflow — that's the BudgetEnforcer's job.
 * - Fires each threshold exactly once per workflow run (tracked by seq of
 *   the first step that crosses it, keyed in a closure Set).
 * - Checks AFTER next() so ctx.bag.durationMs is set and the budget in
 *   ctx.state.budget reflects the last checkpoint (not the current step —
 *   the current step's tokens are applied at checkpoint time by the runtime).
 */

export interface BudgetThresholdOptions {
  /**
   * Fractions [0, 1] at which to fire the alert.
   * Default: [0.8] (80% of any dimension).
   */
  thresholds?: number[];
  /**
   * Which dimensions to monitor.
   * Default: ["costUsd", "tokens"]
   */
  dimensions?: Array<"costUsd" | "tokens" | "steps">;
}

export function withBudgetThreshold(options?: BudgetThresholdOptions): HarnessMiddleware {
  const thresholds = options?.thresholds ?? [0.8];
  const dimensions = options?.dimensions ?? ["costUsd", "tokens"];

  // Tracks which (workflowId, dimension, threshold) combinations have already
  // fired. Keyed as "workflowId:dimension:threshold" so different workflows
  // sharing the same middleware instance do not interfere.
  const fired = new Set<string>();

  return async (ctx, next) => {
    await next();

    const budget = ctx.state.budget;
    const limits = ctx.budget;

    for (const dimension of dimensions) {
      const [current, limit] = (() => {
        switch (dimension) {
          case "costUsd":
            return [budget.costUsd, limits.maxCostUsd];
          case "tokens":
            return [budget.tokensUsed, limits.maxTokens];
          case "steps":
            return [budget.stepsCompleted, limits.maxSteps];
        }
      })();

      if (limit <= 0) continue;

      for (const threshold of thresholds) {
        const key = `${ctx.workflowId}:${dimension}:${threshold}`;
        if (!fired.has(key) && current / limit >= threshold) {
          fired.add(key);

          const input = ctx.step.input as ToolCallInput;
          // Use the next available seq (after withEventEmission incremented it).
          const seq = ctx.bag.nextSeq++;

          const event: BudgetThresholdExceededEvent = {
            id: ctx.idPort.newId(),
            workflowId: ctx.workflowId,
            seq,
            at: ctx.clock.nowIso(),
            type: "budget.threshold.exceeded",
            payload: {
              dimension,
              thresholdPct: threshold,
              current,
              limit,
            },
          };

          await ctx.eventLog.append(event);
          ctx.bag.emittedEvents.push(event);

          // Also record a span event on any active span for correlation.
          // This is a best-effort addition — if there is no active span it is a no-op.
          const { trace } = await import("@opentelemetry/api");
          const activeSpan = trace.getActiveSpan();
          if (activeSpan) {
            activeSpan.addEvent("budget.threshold.exceeded", {
              dimension,
              threshold_pct: threshold,
              current,
              limit,
              tool_name: input.toolName,
            });
          }
        }
      }
    }
  };
}
