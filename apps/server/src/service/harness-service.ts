import type { Budget, HarnessEvent } from "@harness/contracts";
import type { EventLogPort, IdPort, StateStorePort, WorkflowState } from "@harness/core";
import { HarnessRuntime } from "@harness/core";
import type { HarnessRuntimeDeps } from "@harness/core";

// ---------------------------------------------------------------------------
// HarnessService — Facade (Pattern: Facade)
//
// Exposes four simple operations to HTTP/WS controllers.
// Controllers depend on this interface, not on HarnessRuntime, registries, or
// stores directly. Swapping adapters (e.g. Postgres in T06) touches only the
// composition root — this surface never changes.
// ---------------------------------------------------------------------------

export interface StartWorkflowOptions {
  goal: string;
  budget?: Partial<Budget>;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface StartWorkflowResult {
  workflowId: string;
}

export interface HarnessServiceDeps {
  runtimeDeps: HarnessRuntimeDeps;
  eventLog: EventLogPort;
  stateStore: StateStorePort;
  idPort: IdPort;
}

export class HarnessService {
  private readonly runtime: HarnessRuntime;
  private readonly eventLog: EventLogPort;
  private readonly stateStore: StateStorePort;
  private readonly idPort: IdPort;

  /** Default budget applied when the caller doesn't specify. */
  private static readonly DEFAULT_BUDGET: Budget = {
    maxTokens: 100_000,
    maxSteps: 20,
    maxWallClockMs: 300_000,
    maxCostUsd: 5.0,
  };

  constructor(deps: HarnessServiceDeps) {
    this.runtime = new HarnessRuntime(deps.runtimeDeps);
    this.eventLog = deps.eventLog;
    this.stateStore = deps.stateStore;
    this.idPort = deps.idPort;
  }

  /**
   * Start a new workflow asynchronously.
   *
   * Fire-and-forget: returns the workflowId immediately.
   * Events stream through EventBus → WS gateway in real time.
   */
  start(opts: StartWorkflowOptions): StartWorkflowResult {
    const workflowId = this.idPort.newId();
    const budget: Budget = {
      ...HarnessService.DEFAULT_BUDGET,
      ...opts.budget,
    };
    const task = {
      id: workflowId,
      goal: opts.goal,
      budget,
      constraints: opts.constraints,
      metadata: opts.metadata,
    };

    // Fire-and-forget: runtime errors are surfaced through the event log
    // (workflow.failed event), not through this promise.
    void this.runtime.run(task).catch((err: unknown) => {
      console.error(`[harness] unhandled runtime error for workflow ${workflowId}:`, err);
    });

    return { workflowId };
  }

  /** Return the current workflow state, or undefined if not found. */
  async getState(workflowId: string): Promise<WorkflowState | undefined> {
    const versioned = await this.stateStore.load(workflowId);
    return versioned?.state;
  }

  /** Return all events for a workflow starting from fromSeq (inclusive). */
  async getEvents(workflowId: string, fromSeq = 0): Promise<readonly HarnessEvent[]> {
    return this.eventLog.read(workflowId, fromSeq);
  }

  /**
   * Resume a previously interrupted workflow.
   * Reconstructs state from the event log and continues execution from where
   * the process crashed. Emits a workflow.resumed event and re-executes any
   * in-flight tool calls using the idempotency store for crash-safe recovery.
   *
   * Returns the final WorkflowState (completed, failed, or halted).
   */
  async resume(workflowId: string): Promise<WorkflowState> {
    return this.runtime.resume(workflowId);
  }

  /**
   * Record a human approval decision for a pending approval request.
   * Appends an approval.granted event to the log; the WS bus delivers it live.
   * Returns false when the workflow is not found.
   */
  async approveRequest(
    workflowId: string,
    requestId: string,
    decidedBy: string,
    comment?: string,
  ): Promise<boolean> {
    const versioned = await this.stateStore.load(workflowId);
    if (!versioned) return false;
    const now = new Date().toISOString();
    const event: HarnessEvent = {
      id: this.idPort.newId(),
      workflowId,
      seq: versioned.state.seq + 1,
      at: now,
      type: "approval.granted",
      payload: {
        requestId,
        decidedBy,
        decidedAt: now,
        ...(comment !== undefined && { comment }),
      },
    } as HarnessEvent;
    await this.eventLog.append(event);
    return true;
  }

  /**
   * Record a human rejection decision for a pending approval request.
   * Appends an approval.rejected event to the log; the WS bus delivers it live.
   * Returns false when the workflow is not found.
   */
  async rejectRequest(
    workflowId: string,
    requestId: string,
    decidedBy: string,
    reason?: string,
  ): Promise<boolean> {
    const versioned = await this.stateStore.load(workflowId);
    if (!versioned) return false;
    const now = new Date().toISOString();
    const event: HarnessEvent = {
      id: this.idPort.newId(),
      workflowId,
      seq: versioned.state.seq + 1,
      at: now,
      type: "approval.rejected",
      payload: {
        requestId,
        decidedBy,
        decidedAt: now,
        ...(reason !== undefined && { reason }),
      },
    } as HarnessEvent;
    await this.eventLog.append(event);
    return true;
  }
}
