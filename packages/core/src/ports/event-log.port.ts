import type { HarnessEvent } from "@harness/contracts";

export interface EventLogPort {
  /**
   * Append a single event to the log.
   * The implementation must ensure durability before resolving.
   */
  append(event: HarnessEvent): Promise<void>;

  /**
   * Read all events for a workflow starting from (and including) fromSeq.
   * Events are returned in ascending seq order.
   */
  read(workflowId: string, fromSeq?: number): Promise<readonly HarnessEvent[]>;
}

/** No-op implementation — emits and discards events. Useful in unit tests. */
export class NoopEventLog implements EventLogPort {
  async append(_event: HarnessEvent): Promise<void> {
    // intentionally empty
  }

  async read(_workflowId: string, _fromSeq?: number): Promise<readonly HarnessEvent[]> {
    return [];
  }
}
