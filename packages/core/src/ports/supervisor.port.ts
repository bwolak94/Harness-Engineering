import type { Budget } from "@harness/contracts";

// ---------------------------------------------------------------------------
// SubagentResult — outcome of a single fan-out task
// ---------------------------------------------------------------------------

/** A single subagent task completed successfully. */
export type SubagentSuccess<T> = {
  status: "success";
  taskId: string;
  value: T;
};

/** A single subagent task failed (timeout, abort, thrown error). */
export type SubagentFailure = {
  status: "failed";
  taskId: string;
  reason: string;
};

export type SubagentResult<T> = SubagentSuccess<T> | SubagentFailure;

// ---------------------------------------------------------------------------
// SubagentTask — unit of work submitted to the Supervisor
// ---------------------------------------------------------------------------

/**
 * A single unit of work that the Supervisor runs as an isolated subagent.
 *
 * `execute` receives a child AbortSignal derived from the parent signal.
 * Implementations should poll `signal.aborted` at their natural yield points
 * and throw when set — this is the only mechanism for cooperative cancellation.
 *
 * `allocatedBudget` is set by the Supervisor before the task runs; it
 * represents the fraction of the parent budget available to this task.
 * The Supervisor enforces distribution (sum ≤ parent); tasks that spawn
 * their own HarnessRuntime instances should pass this budget as the child's
 * `TaskPacket.budget`.
 */
export interface SubagentTask<TResult> {
  taskId: string;
  execute(signal: AbortSignal): Promise<TResult>;
  /** Populated by the Supervisor after budget distribution. */
  allocatedBudget?: Budget;
}

// ---------------------------------------------------------------------------
// FanOutOptions
// ---------------------------------------------------------------------------

export interface FanOutOptions {
  /**
   * Maximum number of tasks running concurrently.
   * A proper semaphore — slots free as soon as their task finishes.
   * Default: 10.
   */
  concurrencyLimit?: number;
  /**
   * Wall-clock timeout per individual task (milliseconds).
   * When exceeded, the task's child AbortSignal is fired.
   * Undefined = no per-task timeout (rely on parent signal or task-internal logic).
   */
  taskTimeoutMs?: number;
  /** Parent cancellation signal. Propagated to every child AbortController. */
  signal?: AbortSignal;
  /**
   * Budget available to the entire fan-out.
   * Divided equally among tasks; stored in `task.allocatedBudget` before execution.
   */
  parentBudget?: Budget;
}

// ---------------------------------------------------------------------------
// FanOutResult
// ---------------------------------------------------------------------------

export interface FanOutResult<T> {
  results: SubagentResult<T>[];
  /** True when at least one subagent returned status "failed". */
  partial: boolean;
  /** Human-readable synthesis summary. */
  summary: string;
}

// ---------------------------------------------------------------------------
// SupervisorPort
// ---------------------------------------------------------------------------

export interface SupervisorPort {
  fanOut<T>(tasks: SubagentTask<T>[], opts?: FanOutOptions): Promise<FanOutResult<T>>;
}
