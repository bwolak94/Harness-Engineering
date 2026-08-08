import type { Budget } from "@harness/contracts";
import type {
  FanOutOptions,
  FanOutResult,
  SubagentResult,
  SubagentTask,
  SupervisorPort,
} from "../ports/supervisor.port.js";

// ---------------------------------------------------------------------------
// Supervisor — Scatter-Gather with concurrency limit and graceful degradation
// ---------------------------------------------------------------------------

/**
 * Supervisor orchestrates fan-out execution of independent subtasks.
 *
 * Patterns: Scatter-Gather, Bulkhead, Graceful Degradation, Composite
 *
 * Key properties:
 * - Proper semaphore concurrency: a slot frees the moment its task finishes,
 *   not after the entire batch. Slow tasks do not block fast siblings.
 * - Never throws: every task outcome is captured as SubagentResult.
 * - AbortSignal propagation: parent abort is forwarded to every child.
 * - Budget distribution: parent budget divided evenly; sums never exceed parent.
 * - Composite: Supervisor.fanOut itself matches SubagentTask<FanOutResult<T>>
 *   signature, enabling arbitrary nesting depth with no new code.
 */
export class Supervisor implements SupervisorPort {
  constructor(private readonly defaultConcurrencyLimit: number = 10) {}

  async fanOut<T>(tasks: SubagentTask<T>[], opts: FanOutOptions = {}): Promise<FanOutResult<T>> {
    const { concurrencyLimit = this.defaultConcurrencyLimit, taskTimeoutMs, signal } = opts;

    // Distribute parent budget evenly among tasks before execution.
    if (opts.parentBudget && tasks.length > 0) {
      distributeBudget(tasks, opts.parentBudget);
    }

    const results = await runWithConcurrencyLimit(
      tasks.map((task) => () => runTask(task, signal, taskTimeoutMs)),
      Math.max(1, concurrencyLimit),
      signal,
    );

    const successCount = results.filter((r) => r.status === "success").length;
    const failedCount = results.filter((r) => r.status === "failed").length;
    const partial = failedCount > 0;
    const summary = `${successCount} of ${tasks.length} subagents completed successfully${failedCount > 0 ? `; ${failedCount} failed` : ""}.`;

    return { results, partial, summary };
  }
}

// ---------------------------------------------------------------------------
// runTask — execute one SubagentTask, capturing any error as a failure result
// ---------------------------------------------------------------------------

async function runTask<T>(
  task: SubagentTask<T>,
  parentSignal: AbortSignal | undefined,
  taskTimeoutMs: number | undefined,
): Promise<SubagentResult<T>> {
  // Create a child controller that can be aborted independently.
  const childController = new AbortController();

  // Forward parent abort to child.
  const onParentAbort = () => childController.abort("parent_cancelled");
  parentSignal?.addEventListener("abort", onParentAbort);

  // Apply per-task timeout.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (taskTimeoutMs !== undefined) {
    timeoutId = setTimeout(() => childController.abort("timeout"), taskTimeoutMs);
  }

  try {
    // Bail out early if parent was already aborted before we started.
    if (parentSignal?.aborted) {
      return { status: "failed", taskId: task.taskId, reason: "Cancelled before start" };
    }

    const value = await task.execute(childController.signal);
    return { status: "success", taskId: task.taskId, value };
  } catch (err) {
    const reason =
      childController.signal.reason === "timeout"
        ? `Timeout after ${taskTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { status: "failed", taskId: task.taskId, reason };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — proper semaphore (not round-robin batching)
// ---------------------------------------------------------------------------

/**
 * Runs all tasks respecting the concurrency limit.
 * A slot is freed the moment its task finishes — slow tasks do not block fast siblings.
 * If the parent signal fires, no new tasks are started (already-running tasks are handled
 * by their own child AbortSignal via runTask).
 */
async function runWithConcurrencyLimit<T>(
  factories: Array<() => Promise<T>>,
  limit: number,
  parentSignal: AbortSignal | undefined,
): Promise<T[]> {
  const results: T[] = new Array(factories.length);
  let nextIdx = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    function startNext(): void {
      // Stop launching new tasks if the parent was cancelled.
      if (parentSignal?.aborted) {
        if (active === 0) resolve(results);
        return;
      }

      while (active < limit && nextIdx < factories.length) {
        const i = nextIdx++;
        active++;
        const factory = factories[i];
        if (!factory) {
          active--;
          continue;
        }
        factory()
          .then((result) => {
            results[i] = result;
          })
          .catch((err: unknown) => {
            // Individual task errors are swallowed here — runTask never throws.
            // If it somehow did, propagate to avoid a silent hang.
            reject(err);
          })
          .finally(() => {
            active--;
            if (active === 0 && nextIdx >= factories.length) {
              resolve(results);
            } else {
              startNext();
            }
          });
      }

      if (nextIdx >= factories.length && active === 0) {
        resolve(results);
      }
    }

    startNext();
  });
}

// ---------------------------------------------------------------------------
// distributeBudget — divide parent budget evenly among tasks
// ---------------------------------------------------------------------------

function distributeBudget<T>(tasks: SubagentTask<T>[], parent: Budget): void {
  const n = tasks.length;
  const share: Budget = {
    maxTokens: Math.floor(parent.maxTokens / n),
    maxSteps: Math.floor(parent.maxSteps / n),
    maxWallClockMs: Math.floor(parent.maxWallClockMs / n),
    maxCostUsd: parent.maxCostUsd / n,
  };
  for (const task of tasks) {
    task.allocatedBudget = share;
  }
}
