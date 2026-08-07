import type { WorkflowState } from "../domain/workflow-state.js";

export interface VersionedState {
  state: WorkflowState;
  /** Monotonically increasing version used for optimistic concurrency control */
  version: number;
}

export interface StateStorePort {
  /** Load the current state. Returns undefined if the workflow does not exist. */
  load(workflowId: string): Promise<VersionedState | undefined>;

  /**
   * Persist a new state snapshot.
   * @throws {ConcurrentWriteError} if version does not match the stored version.
   */
  save(workflowId: string, state: WorkflowState, expectedVersion: number): Promise<void>;
}

export class ConcurrentWriteError extends Error {
  constructor(workflowId: string, expected: number, actual: number) {
    super(
      `Concurrent write on workflow ${workflowId}: expected version ${expected}, found ${actual}`,
    );
    this.name = "ConcurrentWriteError";
  }
}
