import type { CanaryRunRecord, CanaryStorePort } from "@harness/core";

/**
 * InMemoryCanaryStore — in-memory implementation of CanaryStorePort.
 *
 * Intended for tests and local development. Records are stored in insertion
 * order; `list()` returns newest-first by slicing from the tail.
 */
export class InMemoryCanaryStore implements CanaryStorePort {
  private readonly records: CanaryRunRecord[] = [];

  async save(record: CanaryRunRecord): Promise<void> {
    this.records.push(record);
  }

  async list(baselineFlowId: string, limit = 50): Promise<readonly CanaryRunRecord[]> {
    const filtered = this.records.filter((r) => r.baselineFlowId === baselineFlowId);
    // Newest-first: reverse a copy so the original insertion order is preserved.
    return filtered.slice().reverse().slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Total number of stored records across all flows. */
  size(): number {
    return this.records.length;
  }

  /** Remove all records — useful between tests. */
  clear(): void {
    this.records.length = 0;
  }

  /** Return all records (insertion order) — useful for assertions. */
  all(): readonly CanaryRunRecord[] {
    return this.records;
  }
}
