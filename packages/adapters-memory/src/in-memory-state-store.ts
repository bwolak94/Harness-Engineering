import type { WorkflowState } from "@harness/core";
import type { StateStorePort, VersionedState } from "@harness/core";
import { ConcurrentWriteError } from "@harness/core";

/**
 * InMemoryStateStore — in-memory implementation of StateStorePort.
 *
 * Implements optimistic concurrency via a monotonically increasing version number.
 * Throws ConcurrentWriteError if the expected version doesn't match the stored version.
 *
 * Internal version starts at 0. First successful save increments it to 1.
 */
export class InMemoryStateStore implements StateStorePort {
  private readonly store = new Map<string, { state: WorkflowState; version: number }>();

  async load(workflowId: string): Promise<VersionedState | undefined> {
    return this.store.get(workflowId);
  }

  async save(workflowId: string, state: WorkflowState, expectedVersion: number): Promise<void> {
    const entry = this.store.get(workflowId);
    const currentVersion = entry?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      throw new ConcurrentWriteError(workflowId, expectedVersion, currentVersion);
    }

    this.store.set(workflowId, { state, version: currentVersion + 1 });
  }

  /** Reset the store — useful between tests. */
  clear(): void {
    this.store.clear();
  }
}
