import type { Result } from "../domain/result.js";
import type { ToolCallError } from "./tool-registry.port.js";

// ---------------------------------------------------------------------------
// ToolCacheEntry — a single cached tool result
// ---------------------------------------------------------------------------

export interface ToolCacheEntry {
  /** The cached result (success or error). */
  result: Result<unknown, ToolCallError>;
  /** Epoch ms when this entry was stored. */
  cachedAt: number;
  /** Epoch ms when this entry expires. Undefined = never expires. */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// ToolCachePort — pluggable result cache for idempotent tools
// ---------------------------------------------------------------------------

export interface ToolCachePort {
  /**
   * Look up a cached result by content-addressable key.
   * Returns undefined on a cache miss or if the entry has expired.
   */
  get(key: string): Promise<ToolCacheEntry | undefined>;

  /**
   * Store a result under the given key.
   * @param key    - Content-addressable cache key.
   * @param entry  - The result plus metadata to store.
   */
  set(key: string, entry: ToolCacheEntry): Promise<void>;

  /**
   * Remove a single entry by key.
   * No-op if the key is not present.
   */
  invalidate(key: string): Promise<void>;

  /**
   * Remove all cached entries for a given tool name.
   * Useful when the tool's underlying data changes and all results are stale.
   */
  invalidateByTool(toolName: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopToolCache — disables caching (default in production opt-out)
// ---------------------------------------------------------------------------

export class NoopToolCache implements ToolCachePort {
  async get(_key: string): Promise<ToolCacheEntry | undefined> {
    return undefined;
  }

  async set(_key: string, _entry: ToolCacheEntry): Promise<void> {
    // intentionally empty
  }

  async invalidate(_key: string): Promise<void> {
    // intentionally empty
  }

  async invalidateByTool(_toolName: string): Promise<void> {
    // intentionally empty
  }
}
