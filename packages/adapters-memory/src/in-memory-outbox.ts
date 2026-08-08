import type { OutboxItem, OutboxPort } from "@harness/core";

/**
 * InMemoryOutbox — in-memory implementation of OutboxPort.
 *
 * Used in tests and local development. Not durable across process restarts —
 * use the Postgres adapter in production for true at-least-once delivery.
 */
export class InMemoryOutbox implements OutboxPort {
  private readonly items = new Map<string, OutboxItem>();

  async enqueue(item: OutboxItem): Promise<void> {
    // Idempotent: if an item with the same idempotencyKey exists, skip.
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === item.idempotencyKey) return;
    }
    this.items.set(item.id, { ...item });
  }

  async pending(): Promise<readonly OutboxItem[]> {
    return [...this.items.values()].filter((item) => item.status !== "delivered");
  }

  async markDelivered(id: string): Promise<void> {
    const item = this.items.get(id);
    if (item) {
      this.items.set(id, { ...item, status: "delivered" });
    }
  }

  async recordFailure(id: string): Promise<void> {
    const item = this.items.get(id);
    if (item) {
      this.items.set(id, {
        ...item,
        attempts: item.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        status: "failed",
      });
    }
  }

  /** Return all items regardless of status (useful for assertions in tests). */
  all(): readonly OutboxItem[] {
    return [...this.items.values()];
  }

  /** Reset — useful between tests. */
  clear(): void {
    this.items.clear();
  }
}
