import type { WorkflowStatus } from "@harness/contracts";

/**
 * WorkflowState — in-memory representation of a running workflow.
 * Reconstructed by replaying HarnessEvents through the reducer.
 *
 * Plain object (not a class) so it can be serialised to JSON for checkpointing.
 * The reducer is the only function that produces new states.
 */
export interface BudgetUsage {
  tokensUsed: number;
  stepsCompleted: number;
  wallClockMs: number;
  costUsd: number;
}

export interface PendingStep {
  stepId: string;
  kind: "tool_call" | "llm_turn" | "handoff";
  input: unknown;
  meta?: Record<string, unknown>;
}

export interface WorkflowState {
  readonly workflowId: string;
  readonly status: WorkflowStatus;
  /** Sequence number of the last event applied. Monotonically increasing. */
  readonly seq: number;
  readonly budget: BudgetUsage;
  readonly pendingSteps: readonly PendingStep[];
  readonly suspendedAt?: string;
  readonly resumeToken?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly error?: string;
  readonly result?: unknown;
}

/** Initial state before any events are applied. */
export function initialWorkflowState(workflowId: string): WorkflowState {
  return {
    workflowId,
    status: "pending",
    seq: -1,
    budget: {
      tokensUsed: 0,
      stepsCompleted: 0,
      wallClockMs: 0,
      costUsd: 0,
    },
    pendingSteps: [],
  };
}
