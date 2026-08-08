import type { MemoryFact, MemoryStorePort, MemorySummary } from "@harness/core";

/**
 * InMemoryMemoryStore — in-memory implementation of MemoryStorePort (T09).
 *
 * Used in unit tests and local development. Not thread-safe.
 *
 * Facts are stored in a Map (keyed by workflowId → key → value).
 * Summaries are stored as append-only arrays, deduplicated by summary.id.
 */
export class InMemoryMemoryStore implements MemoryStorePort {
  private readonly facts = new Map<string, Map<string, string>>();
  private readonly summaries = new Map<string, MemorySummary[]>();

  async getFacts(workflowId: string): Promise<readonly MemoryFact[]> {
    const wf = this.facts.get(workflowId);
    if (wf === undefined) return [];
    return Array.from(wf.entries()).map(([key, value]) => ({ key, value }));
  }

  async setFact(workflowId: string, key: string, value: string): Promise<void> {
    let wf = this.facts.get(workflowId);
    if (wf === undefined) {
      wf = new Map();
      this.facts.set(workflowId, wf);
    }
    wf.set(key, value);
  }

  async addSummary(workflowId: string, summary: MemorySummary): Promise<void> {
    let wf = this.summaries.get(workflowId);
    if (wf === undefined) {
      wf = [];
      this.summaries.set(workflowId, wf);
    }
    // Idempotent: do not add if a summary with the same id already exists.
    if (wf.some((s) => s.id === summary.id)) return;
    wf.push(summary);
  }

  async getSummaries(workflowId: string): Promise<readonly MemorySummary[]> {
    return this.summaries.get(workflowId) ?? [];
  }

  /** Returns total number of facts across all workflows — useful for test assertions. */
  factCount(workflowId: string): number {
    return this.facts.get(workflowId)?.size ?? 0;
  }

  /** Returns total number of summaries for a workflow. */
  summaryCount(workflowId: string): number {
    return this.summaries.get(workflowId)?.length ?? 0;
  }

  /** Reset all state — useful between tests. */
  clear(): void {
    this.facts.clear();
    this.summaries.clear();
  }
}
