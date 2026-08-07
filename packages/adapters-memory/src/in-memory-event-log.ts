import type { HarnessEvent } from "@harness/contracts";
import type { EventLogPort } from "@harness/core";

/**
 * InMemoryEventLog — in-memory implementation of EventLogPort.
 *
 * Events are stored in a Map keyed by workflowId and sorted by seq.
 * Used in unit tests and local development. Not thread-safe.
 */
export class InMemoryEventLog implements EventLogPort {
  private readonly store = new Map<string, HarnessEvent[]>();

  async append(event: HarnessEvent): Promise<void> {
    let log = this.store.get(event.workflowId);
    if (log === undefined) {
      log = [];
      this.store.set(event.workflowId, log);
    }
    // Idempotent: skip if an event with the same seq already exists (matches Postgres behaviour).
    if (log.some((e) => e.seq === event.seq)) return;
    log.push(event);
  }

  async read(workflowId: string, fromSeq = 0): Promise<readonly HarnessEvent[]> {
    const log = this.store.get(workflowId);
    if (log === undefined) return [];
    // Sort ascending by seq to match the Postgres ORDER BY seq guarantee.
    return log
      .filter((e) => e.seq >= fromSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Returns all events across all workflows (useful for assertions in tests). */
  all(): readonly HarnessEvent[] {
    const result: HarnessEvent[] = [];
    for (const log of this.store.values()) {
      result.push(...log);
    }
    return result;
  }

  /** Reset the store — useful between tests. */
  clear(): void {
    this.store.clear();
  }
}
