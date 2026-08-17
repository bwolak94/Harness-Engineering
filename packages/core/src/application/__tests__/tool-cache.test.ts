import { describe, expect, it, vi } from "vitest";
import { err, ok } from "../../domain/result.js";
import type { ToolCacheEntry, ToolCachePort } from "../../ports/tool-cache.port.js";
import { NoopToolCache } from "../../ports/tool-cache.port.js";
import type { ToolExecutor } from "../../ports/tool-registry.port.js";
import { buildCacheKey } from "../tool-cache-key.js";
import { withToolCache } from "../tool-decorators.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeExecutor(name: string, executeFn: ToolExecutor["execute"]): ToolExecutor {
  return {
    definition: {
      name,
      description: "test",
      dangerous: false,
      idempotent: true,
      costHint: "free" as const,
      inputSchema: {},
      outputSchema: {},
    },
    execute: executeFn,
  };
}

function successExecutor(name = "tool", value: unknown = "result"): ToolExecutor {
  return makeExecutor(name, async () => ok(value));
}

/** Minimal in-memory cache for use in core unit tests (no adapters-memory dependency). */
class SimpleCache implements ToolCachePort {
  readonly store = new Map<string, ToolCacheEntry>();
  readonly toolIndex = new Map<string, Set<string>>();

  async get(key: string): Promise<ToolCacheEntry | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, entry: ToolCacheEntry): Promise<void> {
    this.store.set(key, entry);
    const toolName = key.split(":")[0] ?? key;
    const keys = this.toolIndex.get(toolName) ?? new Set<string>();
    keys.add(key);
    this.toolIndex.set(toolName, keys);
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
  }

  async invalidateByTool(toolName: string): Promise<void> {
    for (const [key] of this.store) {
      if (key.startsWith(`${toolName}:`)) {
        this.store.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
  it("returns a string containing the tool name as prefix", () => {
    const key = buildCacheKey("myTool", { a: 1 });
    expect(key.startsWith("myTool:")).toBe(true);
  });

  it("produces the same key for semantically identical inputs regardless of key order", () => {
    const k1 = buildCacheKey("tool", { b: 2, a: 1 });
    const k2 = buildCacheKey("tool", { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it("produces different keys for different inputs", () => {
    const k1 = buildCacheKey("tool", { a: 1 });
    const k2 = buildCacheKey("tool", { a: 2 });
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different tool names with same input", () => {
    const k1 = buildCacheKey("toolA", { x: 1 });
    const k2 = buildCacheKey("toolB", { x: 1 });
    expect(k1).not.toBe(k2);
  });

  it("handles null input gracefully", () => {
    expect(() => buildCacheKey("tool", null)).not.toThrow();
  });

  it("handles undefined input gracefully", () => {
    expect(() => buildCacheKey("tool", undefined)).not.toThrow();
  });

  it("handles deeply nested objects deterministically", () => {
    const k1 = buildCacheKey("tool", { c: { z: 3, y: 2 }, b: 1 });
    const k2 = buildCacheKey("tool", { b: 1, c: { y: 2, z: 3 } });
    expect(k1).toBe(k2);
  });

  it("distinguishes arrays from objects with numeric-string keys", () => {
    const kArr = buildCacheKey("tool", [1, 2]);
    const kObj = buildCacheKey("tool", { 0: 1, 1: 2 });
    expect(kArr).not.toBe(kObj);
  });
});

// ---------------------------------------------------------------------------
// NoopToolCache
// ---------------------------------------------------------------------------

describe("NoopToolCache", () => {
  it("always returns undefined on get", async () => {
    const cache = new NoopToolCache();
    expect(await cache.get("any-key")).toBeUndefined();
  });

  it("set is a no-op and resolves", async () => {
    const cache = new NoopToolCache();
    await expect(cache.set("k", { result: ok("x"), cachedAt: 0 })).resolves.toBeUndefined();
  });

  it("invalidate is a no-op and resolves", async () => {
    const cache = new NoopToolCache();
    await expect(cache.invalidate("k")).resolves.toBeUndefined();
  });

  it("invalidateByTool is a no-op and resolves", async () => {
    const cache = new NoopToolCache();
    await expect(cache.invalidateByTool("tool")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// withToolCache decorator
// ---------------------------------------------------------------------------

describe("withToolCache", () => {
  it("returns the inner result on cache miss", async () => {
    const cache = new SimpleCache();
    const inner = successExecutor("tool", "fresh");
    const wrapped = withToolCache(cache)(inner);
    const result = await wrapped.execute({ x: 1 });
    expect(result).toEqual(ok("fresh"));
  });

  it("returns cached result on second call without executing inner", async () => {
    const cache = new SimpleCache();
    const executeSpy = vi.fn().mockResolvedValue(ok("first"));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(cache)(inner);

    await wrapped.execute({ x: 1 });
    await wrapped.execute({ x: 1 });

    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("executes inner for different inputs (different cache key)", async () => {
    const cache = new SimpleCache();
    const executeSpy = vi.fn().mockResolvedValue(ok("val"));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(cache)(inner);

    await wrapped.execute({ x: 1 });
    await wrapped.execute({ x: 2 });

    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache error results by default", async () => {
    const cache = new SimpleCache();
    const executeSpy = vi
      .fn()
      .mockResolvedValue(err({ code: "EXEC_ERROR", message: "fail", retryable: false }));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(cache)(inner);

    await wrapped.execute({ x: 1 });
    await wrapped.execute({ x: 1 });

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });

  it("caches error results when cacheErrors:true", async () => {
    const cache = new SimpleCache();
    const executeSpy = vi
      .fn()
      .mockResolvedValue(err({ code: "EXEC_ERROR", message: "fail", retryable: false }));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(cache, { cacheErrors: true })(inner);

    await wrapped.execute({ x: 1 });
    await wrapped.execute({ x: 1 });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(1);
  });

  it("re-executes after cached entry expires (ttlMs)", async () => {
    const cache = new SimpleCache();
    const executeSpy = vi.fn().mockResolvedValue(ok("val"));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(cache, { ttlMs: 1 })(inner);

    await wrapped.execute({ x: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await wrapped.execute({ x: 1 });

    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves the definition from the inner executor", () => {
    const cache = new SimpleCache();
    const inner = successExecutor("my-tool");
    const wrapped = withToolCache(cache)(inner);
    expect(wrapped.definition).toBe(inner.definition);
  });

  it("works correctly with NoopToolCache (always misses)", async () => {
    const noop = new NoopToolCache();
    const executeSpy = vi.fn().mockResolvedValue(ok("v"));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(noop)(inner);

    await wrapped.execute({ a: 1 });
    await wrapped.execute({ a: 1 });

    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("canonicalises input key order — cache hit for key-permuted inputs", async () => {
    const cache = new SimpleCache();
    const executeSpy = vi.fn().mockResolvedValue(ok("v"));
    const inner = makeExecutor("tool", executeSpy);
    const wrapped = withToolCache(cache)(inner);

    await wrapped.execute({ b: 2, a: 1 });
    await wrapped.execute({ a: 1, b: 2 });

    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("stores entry with correct cachedAt timestamp", async () => {
    const cache = new SimpleCache();
    const before = Date.now();
    const inner = successExecutor("tool", "x");
    await withToolCache(cache)(inner).execute({});
    const after = Date.now();

    const entries = [...cache.store.values()];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.cachedAt).toBeGreaterThanOrEqual(before);
      expect(entry.cachedAt).toBeLessThanOrEqual(after);
    }
  });

  it("stores entry with expiresAt when ttlMs is set", async () => {
    const cache = new SimpleCache();
    const TTL = 5000;
    const before = Date.now();
    const inner = successExecutor("tool", "x");
    await withToolCache(cache, { ttlMs: TTL })(inner).execute({});
    const after = Date.now();

    const entries = [...cache.store.values()];
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.expiresAt).toBeGreaterThanOrEqual(before + TTL);
      expect(entry.expiresAt).toBeLessThanOrEqual(after + TTL);
    }
  });

  it("stores entry without expiresAt when ttlMs is not set", async () => {
    const cache = new SimpleCache();
    const inner = successExecutor("tool", "x");
    await withToolCache(cache)(inner).execute({});

    const entries = [...cache.store.values()];
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.expiresAt).toBeUndefined();
    }
  });
});
