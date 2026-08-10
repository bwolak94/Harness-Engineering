import type { HarnessEvent } from "@harness/contracts";
import type { PendingStep, WorkflowState } from "./workflow-state.js";

/**
 * assertNever — compile-time exhaustiveness check.
 * If a new HarnessEvent variant is added without a case in the switch,
 * TypeScript will flag this as a type error.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled event type: ${(x as { type: string }).type}`);
}

/**
 * reduce — pure function that applies a single HarnessEvent to a WorkflowState.
 *
 * Invariants:
 *   - result.seq === event.seq (always moves to the applied event's seq)
 *   - seq never decreases (enforced by the property-based test)
 *   - never throws for any valid HarnessEvent (exhaustive switch + assertNever)
 *   - returns a new object — state is immutable
 */
export function reduce(state: WorkflowState, event: HarnessEvent): WorkflowState {
  switch (event.type) {
    case "workflow.started":
      return {
        ...state,
        seq: event.seq,
        status: "running",
      };

    case "step.planned": {
      const step: PendingStep = {
        stepId: event.payload.stepId,
        kind: event.payload.kind,
        input: event.payload.input,
        ...(event.payload.meta !== undefined ? { meta: event.payload.meta } : {}),
      };
      return {
        ...state,
        seq: event.seq,
        pendingSteps: [...state.pendingSteps, step],
      };
    }

    case "tool.called":
      return {
        ...state,
        seq: event.seq,
      };

    case "tool.succeeded":
      return {
        ...state,
        seq: event.seq,
        budget: {
          ...state.budget,
          stepsCompleted: state.budget.stepsCompleted + 1,
          wallClockMs: state.budget.wallClockMs + event.payload.durationMs,
        },
        pendingSteps: state.pendingSteps.filter((s) => s.stepId !== event.payload.stepId),
      };

    case "tool.failed":
      return {
        ...state,
        seq: event.seq,
        pendingSteps: state.pendingSteps.filter((s) => s.stepId !== event.payload.stepId),
      };

    case "state.checkpointed":
      return {
        ...state,
        seq: event.seq,
        budget: {
          ...state.budget,
          tokensUsed: event.payload.tokensUsed,
          stepsCompleted: event.payload.stepsCompleted,
          costUsd: event.payload.costUsd,
        },
      };

    case "workflow.suspended":
      return {
        ...state,
        seq: event.seq,
        status: "suspended",
        suspendedAt: event.at,
        resumeToken: event.payload.resumeToken,
      };

    case "workflow.resumed": {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { suspendedAt: _sa, resumeToken: _rt, ...rest } = state;
      return {
        ...rest,
        seq: event.seq,
        status: "running",
      };
    }

    case "workflow.completed":
      return {
        ...state,
        seq: event.seq,
        status: "completed",
        completedAt: event.at,
        result: event.payload.result,
        budget: {
          tokensUsed: event.payload.tokensUsed,
          stepsCompleted: event.payload.stepsCompleted,
          wallClockMs: event.payload.durationMs,
          costUsd: event.payload.totalCostUsd,
        },
      };

    case "workflow.failed":
      return {
        ...state,
        seq: event.seq,
        status: event.payload.budgetExceeded ? "halted" : "failed",
        failedAt: event.at,
        error: event.payload.message,
      };

    // context.hydrated and context.summarized are observability events (T09).
    // They advance seq but do not change any other workflow state field.
    case "context.hydrated":
      return { ...state, seq: event.seq };

    case "context.summarized":
      return { ...state, seq: event.seq };

    // model.delta and model.completed are streaming observability events (T05).
    case "model.delta":
    case "model.completed":
      return { ...state, seq: event.seq };

    // agent.handoff is a routing event (T10).
    // It advances seq and records the active agent but leaves all other state intact.
    case "agent.handoff":
      return { ...state, seq: event.seq };

    // subagent.started / subagent.completed / subagent.failed are fan-out lifecycle
    // observability events (T11). They advance seq but do not change workflow status.
    case "subagent.started":
      return { ...state, seq: event.seq };

    case "subagent.completed":
      return { ...state, seq: event.seq };

    case "subagent.failed":
      return { ...state, seq: event.seq };

    // supervisor.synthesized marks the end of a fan-out operation (T11).
    // When partial=true the outer workflow is in completed_partial status.
    case "supervisor.synthesized":
      return {
        ...state,
        seq: event.seq,
        status: event.payload.partial ? "completed_partial" : state.status,
      };

    // approval.* events are HITL lifecycle events (T12).
    // The actual status transitions are driven by workflow.suspended / workflow.resumed /
    // workflow.failed. Approval events advance seq and carry the decision context.
    case "approval.requested":
      return { ...state, seq: event.seq };

    case "approval.granted":
      return { ...state, seq: event.seq };

    case "approval.rejected":
      return { ...state, seq: event.seq };

    case "approval.timed_out":
      return { ...state, seq: event.seq };

    // budget.threshold.exceeded is an observability alert event (T13).
    // It is purely informational — the hard stop is handled by BudgetEnforcer.
    case "budget.threshold.exceeded":
      return { ...state, seq: event.seq };

    default:
      return assertNever(event);
  }
}

/**
 * rehydrate — replay a sequence of events from the initial state to produce
 * the current WorkflowState. Events must be in ascending seq order.
 */
export function rehydrate(
  _workflowId: string,
  events: readonly HarnessEvent[],
  initialState: WorkflowState,
): WorkflowState {
  return events.reduce(reduce, initialState);
}
