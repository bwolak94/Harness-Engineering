import type { IdempotencyStorePort } from "@harness/core";

/**
 * InMemoryIdempotencyStore — in-memory implementation of IdempotencyStorePort.
 *
 * Used in tests and local development. Not durable across process restarts —
 * use the Postgres adapter in production for true crash safety.
 */
export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown | undefined> {
    return this.store.get(key);
  }

  async set(key: string, result: unknown): Promise<void> {
    this.store.set(key, result);
  }

  /** Returns the number of cached entries (useful for assertions in tests). */
  size(): number {
    return this.store.size;
  }

  /** Reset — useful between tests. */
  clear(): void {
    this.store.clear();
  }
}
