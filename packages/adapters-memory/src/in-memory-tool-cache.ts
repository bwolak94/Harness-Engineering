import type { ToolCacheEntry, ToolCachePort } from "@harness/core";

/**
 * InMemoryToolCache — in-memory implementation of ToolCachePort.
 *
 * Intended for tests and local development. Entries are stored in a plain Map
 * keyed by the content-addressable cache key produced by `buildCacheKey()`.
 *
 * TTL expiry is enforced lazily on `get()` — no background sweeper.
 * Call `purgeExpired()` manually if memory usage matters in long-running tests.
 */
export class InMemoryToolCache implements ToolCachePort {
  private readonly store = new Map<string, ToolCacheEntry>();

  async get(key: string): Promise<ToolCacheEntry | undefined> {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;

    // Lazy TTL check
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    return entry;
  }

  async set(key: string, entry: ToolCacheEntry): Promise<void> {
    this.store.set(key, entry);
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
  }

  async invalidateByTool(toolName: string): Promise<void> {
    const prefix = `${toolName}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Total number of live entries (including potentially expired ones). */
  size(): number {
    return this.store.size;
  }

  /** Remove all entries — useful between tests. */
  clear(): void {
    this.store.clear();
  }

  /** Remove entries whose TTL has elapsed (triggers lazy expiry eagerly). */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
