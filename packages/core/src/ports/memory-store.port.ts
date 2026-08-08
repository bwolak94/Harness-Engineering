/**
 * MemoryStorePort — persistent storage for context hydration (T09).
 *
 * Three memory tiers:
 *   - Facts:     persistent key-value pairs set by the runtime (survive across turns).
 *   - Summaries: compressed history blobs produced by the Summarizer.
 *
 * This port follows the Cache-Aside pattern: the runtime populates the store
 * from the event log on resume, then reads from the store throughout the workflow.
 * This ensures summarization never runs twice for the same history slice.
 */

export interface MemoryFact {
  key: string;
  value: string;
}

export interface MemorySummary {
  /** Stable ID, stored in the context.summarized event and used for deduplication. */
  id: string;
  /** Seq of the first message included in this summary. */
  fromSeq: number;
  /** Seq of the last message included in this summary. */
  toSeq: number;
  /** Compressed content produced by the Summarizer. */
  content: string;
  /** Number of messages compressed into this summary. */
  messageCount: number;
  createdAt: string;
}

export interface MemoryStorePort {
  /** Retrieve all persistent facts for a workflow. */
  getFacts(workflowId: string): Promise<readonly MemoryFact[]>;
  /** Set or update a persistent fact. */
  setFact(workflowId: string, key: string, value: string): Promise<void>;
  /** Store a new summary. Idempotent: existing summary with same id is not duplicated. */
  addSummary(workflowId: string, summary: MemorySummary): Promise<void>;
  /** Retrieve all summaries for a workflow in creation order. */
  getSummaries(workflowId: string): Promise<readonly MemorySummary[]>;
}

/**
 * NoopMemoryStore — zero-I/O implementation that returns empty results.
 *
 * Used as the default in HarnessRuntime and in environments where no memory
 * adapter is wired up. The model receives no injected facts or summaries.
 */
export class NoopMemoryStore implements MemoryStorePort {
  async getFacts(_workflowId: string): Promise<readonly MemoryFact[]> {
    return [];
  }
  async setFact(_workflowId: string, _key: string, _value: string): Promise<void> {}
  async addSummary(_workflowId: string, _summary: MemorySummary): Promise<void> {}
  async getSummaries(_workflowId: string): Promise<readonly MemorySummary[]> {
    return [];
  }
}
