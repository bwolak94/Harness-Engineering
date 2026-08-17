import { ok } from "@harness/core";
import { describe, expect, it } from "vitest";
import { InMemoryToolCache } from "../in-memory-tool-cache.js";

describe("InMemoryToolCache", () => {
  it("returns undefined for a key not yet stored", async () => {
    const cache = new InMemoryToolCache();
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves an entry", async () => {
    const cache = new InMemoryToolCache();
    const entry = { result: ok("hello"), cachedAt: Date.now() };
    await cache.set("k", entry);
    const hit = await cache.get("k");
    expect(hit).toEqual(entry);
  });

  it("invalidate removes a single key", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("k1", { result: ok(1), cachedAt: 0 });
    await cache.set("k2", { result: ok(2), cachedAt: 0 });
    await cache.invalidate("k1");
    expect(await cache.get("k1")).toBeUndefined();
    expect(await cache.get("k2")).toBeDefined();
  });

  it("invalidate is a no-op for missing keys", async () => {
    const cache = new InMemoryToolCache();
    await expect(cache.invalidate("no-such-key")).resolves.toBeUndefined();
  });

  it("invalidateByTool removes all keys with matching prefix", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("toolA:aabbccdd", { result: ok(1), cachedAt: 0 });
    await cache.set("toolA:11223344", { result: ok(2), cachedAt: 0 });
    await cache.set("toolB:deadbeef", { result: ok(3), cachedAt: 0 });
    await cache.invalidateByTool("toolA");
    expect(await cache.get("toolA:aabbccdd")).toBeUndefined();
    expect(await cache.get("toolA:11223344")).toBeUndefined();
    expect(await cache.get("toolB:deadbeef")).toBeDefined();
  });

  it("invalidateByTool is a no-op when tool has no entries", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("other:abc", { result: ok(1), cachedAt: 0 });
    await expect(cache.invalidateByTool("ghost")).resolves.toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it("returns undefined for an expired entry (lazy TTL)", async () => {
    const cache = new InMemoryToolCache();
    const pastMs = Date.now() - 1000;
    await cache.set("k", { result: ok("stale"), cachedAt: pastMs - 5000, expiresAt: pastMs });
    expect(await cache.get("k")).toBeUndefined();
  });

  it("removes expired entry from the map on lazy eviction", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("k", { result: ok("stale"), cachedAt: 0, expiresAt: Date.now() - 1 });
    await cache.get("k"); // triggers eviction
    expect(cache.size()).toBe(0);
  });

  it("returns a live entry before its TTL elapses", async () => {
    const cache = new InMemoryToolCache();
    const entry = { result: ok("fresh"), cachedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    await cache.set("k", entry);
    const hit = await cache.get("k");
    expect(hit).toBeDefined();
    expect(hit?.result).toEqual(ok("fresh"));
  });

  it("entries without expiresAt never expire", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("k", { result: ok("eternal"), cachedAt: 0 });
    expect(await cache.get("k")).toBeDefined();
  });

  it("size() reflects live entry count", async () => {
    const cache = new InMemoryToolCache();
    expect(cache.size()).toBe(0);
    await cache.set("a", { result: ok(1), cachedAt: 0 });
    await cache.set("b", { result: ok(2), cachedAt: 0 });
    expect(cache.size()).toBe(2);
  });

  it("clear() empties the cache", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("a", { result: ok(1), cachedAt: 0 });
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(await cache.get("a")).toBeUndefined();
  });

  it("purgeExpired() removes only expired entries", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("live", { result: ok(1), cachedAt: 0, expiresAt: Date.now() + 60_000 });
    await cache.set("dead", { result: ok(2), cachedAt: 0, expiresAt: Date.now() - 1 });
    cache.purgeExpired();
    expect(cache.size()).toBe(1);
    expect(await cache.get("live")).toBeDefined();
  });

  it("purgeExpired() is a no-op when no entries are expired", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("a", { result: ok(1), cachedAt: 0, expiresAt: Date.now() + 60_000 });
    cache.purgeExpired();
    expect(cache.size()).toBe(1);
  });

  it("overwriting a key replaces the existing entry", async () => {
    const cache = new InMemoryToolCache();
    await cache.set("k", { result: ok("first"), cachedAt: 0 });
    await cache.set("k", { result: ok("second"), cachedAt: 1 });
    const hit = await cache.get("k");
    expect(hit?.result).toEqual(ok("second"));
  });
});
