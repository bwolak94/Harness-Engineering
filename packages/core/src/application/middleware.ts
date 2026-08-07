import type {
  HarnessEvent,
  ToolCalledEvent,
  ToolFailedEvent,
  ToolSucceededEvent,
} from "@harness/contracts";
import type { BudgetEnforcer } from "./budget-enforcer.js";
import type { LoopDetector } from "./loop-detector.js";
import type { StepContext } from "./step.js";
import type { ToolCallInput } from "./step.js";

/**
 * HarnessMiddleware — a single link in the middleware chain.
 *
 * Pattern: Koa-style "onion" — each middleware wraps the rest of the chain
 * via `next`. Call next() to pass control forward; don't call it to short-circuit.
 *
 * Cross-cutting concerns (budget, loop detection, telemetry, event emission)
 * are implemented as separate middlewares and composed. This keeps the runtime
 * loop free of orthogonal logic (SRP) and makes each concern independently
 * testable and reorderable (OCP).
 */
export type HarnessMiddleware = (ctx: StepContext, next: () => Promise<void>) => Promise<void>;

/**
 * compose — chains N middlewares into a single middleware.
 *
 * Middlewares are called left-to-right (first = outermost wrapper).
 * The provided `next` from the caller becomes the terminal action after
 * all middlewares have run.
 *
 * Example: compose(withTiming, withBudget, withEventEmission)
 *   → withTiming wraps withBudget which wraps withEventEmission which calls next.
 */
export function compose(...middlewares: readonly HarnessMiddleware[]): HarnessMiddleware {
  return async (ctx, finalNext) => {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error("next() called multiple times in middleware");
      }
      index = i;
      const fn = i < middlewares.length ? middlewares[i] : finalNext;
      if (fn) {
        await fn(ctx, () => dispatch(i + 1));
      }
    };

    await dispatch(0);
  };
}

// ---------------------------------------------------------------------------
// Built-in middleware
// ---------------------------------------------------------------------------

/**
 * withBudget — pre-step budget gate.
 *
 * Checks the current budget usage before allowing the step to proceed.
 * If any limit is exceeded, writes to ctx.bag.budgetExceeded and skips next().
 * The runtime reads bag.budgetExceeded after the chain to decide whether to halt.
 */
export function withBudget(enforcer: BudgetEnforcer): HarnessMiddleware {
  return async (ctx, next) => {
    const exceeded = enforcer.check(ctx.state.budget);
    if (exceeded) {
      ctx.bag.budgetExceeded = exceeded;
      // Do not call next() — short-circuit the chain.
      return;
    }
    await next();
  };
}

/**
 * withLoopDetection — records tool invocations and injects corrective messages.
 *
 * Records each (toolName, args) pair before calling next().
 * If the invocation count reaches the threshold, writes a corrective message
 * to ctx.bag.correctiveMessage. The runtime injects this message into the
 * conversation after the step completes so the model can self-correct.
 *
 * Notably, this does NOT skip next() — the step still executes. Loop detection
 * is advisory; the budget enforcer is the hard stop.
 */
export function withLoopDetection(detector: LoopDetector): HarnessMiddleware {
  return async (ctx, next) => {
    const input = ctx.step.input as ToolCallInput;
    const corrective = detector.record(input.toolName, input.args);
    if (corrective !== null) {
      ctx.bag.correctiveMessage = corrective;
    }
    await next();
  };
}

/**
 * withEventEmission — emits tool lifecycle events to the event log.
 *
 * Before next(): emits tool.called.
 * After next() success: emits tool.succeeded.
 * After next() with error in bag: emits tool.failed.
 *
 * All emitted events are also pushed to ctx.bag.emittedEvents so the runtime
 * can apply them to the workflow state via the reducer without re-reading the log.
 */
export function withEventEmission(): HarnessMiddleware {
  return async (ctx, next) => {
    const input = ctx.step.input as ToolCallInput;

    // --- tool.called ---
    const calledEvent: ToolCalledEvent = {
      id: ctx.idPort.newId(),
      workflowId: ctx.workflowId,
      seq: ctx.bag.nextSeq++,
      at: ctx.clock.nowIso(),
      type: "tool.called",
      payload: {
        stepId: ctx.step.stepId,
        toolName: input.toolName,
        args: input.args,
        callId: input.callId,
      },
    };
    await emitEvent(ctx, calledEvent);

    await next();

    if (ctx.bag.error === null) {
      // --- tool.succeeded ---
      const succeededEvent: ToolSucceededEvent = {
        id: ctx.idPort.newId(),
        workflowId: ctx.workflowId,
        seq: ctx.bag.nextSeq++,
        at: ctx.clock.nowIso(),
        type: "tool.succeeded",
        payload: {
          stepId: ctx.step.stepId,
          callId: input.callId,
          result: ctx.bag.result,
          durationMs: ctx.bag.durationMs,
        },
      };
      await emitEvent(ctx, succeededEvent);
    } else {
      // --- tool.failed ---
      const failedEvent: ToolFailedEvent = {
        id: ctx.idPort.newId(),
        workflowId: ctx.workflowId,
        seq: ctx.bag.nextSeq++,
        at: ctx.clock.nowIso(),
        type: "tool.failed",
        payload: {
          stepId: ctx.step.stepId,
          callId: input.callId,
          code: ctx.bag.error.code,
          message: ctx.bag.error.message,
          retryable: ctx.bag.error.retryable,
        },
      };
      await emitEvent(ctx, failedEvent);
    }
  };
}

/**
 * withTiming — measures wall-clock duration of the inner chain.
 *
 * Writes startedAt and durationMs to ctx.bag so downstream middleware
 * (especially withEventEmission) can include accurate timing in events.
 * Must be placed OUTSIDE withEventEmission in the compose call to ensure
 * durationMs is set before tool.succeeded is emitted.
 */
export function withTiming(): HarnessMiddleware {
  return async (ctx, next) => {
    ctx.bag.startedAt = ctx.clock.now();
    await next();
    ctx.bag.durationMs = ctx.clock.now() - ctx.bag.startedAt;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function emitEvent(ctx: StepContext, event: HarnessEvent): Promise<void> {
  await ctx.eventLog.append(event);
  ctx.bag.emittedEvents.push(event);
}
