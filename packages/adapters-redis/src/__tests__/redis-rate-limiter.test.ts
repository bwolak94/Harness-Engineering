/**
 * RedisRateLimiter integration tests (T17 Definition of Done).
 *
 * Requires Testcontainers + Docker.
 *
 * DoD coverage:
 *  ✅ tryConsume returns allowed=true and decrements remaining
 *  ✅ tryConsume returns allowed=false when limit is exceeded
 *  ✅ resetMs is non-zero when denied
 *  ✅ window slides: old entries expire and new ones are allowed again
 *  ✅ different keys are isolated
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { RedisRateLimiter } from "../redis-rate-limiter.js";

// ---------------------------------------------------------------------------
// Docker availability guard
// ---------------------------------------------------------------------------

let dockerAvailable = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerAvailable = true;
} catch {
  // Docker not available — suite will be skipped.
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)("RedisRateLimiter (Testcontainers)", () => {
  let redis: Redis;
  let limiter: RedisRateLimiter;

  beforeAll(async () => {
    const { RedisContainer } = await import("@testcontainers/redis");
    const container = await new RedisContainer("redis:7-alpine").start();

    const IORedis = (await import("ioredis")).default;
    redis = new IORedis(container.getConnectionUrl());
    limiter = new RedisRateLimiter(redis);
  }, 60_000);

  afterAll(async () => {
    await redis.quit();
  });

  it("allows requests within the limit", async () => {
    const key = "test:allow";
    const result = await limiter.tryConsume(key, 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("denies requests that exceed the limit", async () => {
    const key = "test:deny";
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      await limiter.tryConsume(key, limit, 60_000);
    }

    const result = await limiter.tryConsume(key, limit, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetMs).toBeGreaterThan(0);
  });

  it("different keys are isolated", async () => {
    const limit = 2;
    const keyA = "test:isolate-a";
    const keyB = "test:isolate-b";

    // Exhaust key A
    await limiter.tryConsume(keyA, limit, 60_000);
    await limiter.tryConsume(keyA, limit, 60_000);
    const denyA = await limiter.tryConsume(keyA, limit, 60_000);
    expect(denyA.allowed).toBe(false);

    // Key B is untouched
    const allowB = await limiter.tryConsume(keyB, limit, 60_000);
    expect(allowB.allowed).toBe(true);
  });

  it("window slides: entries expire and new requests are allowed", async () => {
    const key = "test:sliding";
    const limit = 2;
    const windowMs = 200; // 200ms window for fast test

    await limiter.tryConsume(key, limit, windowMs);
    await limiter.tryConsume(key, limit, windowMs);
    const denied = await limiter.tryConsume(key, limit, windowMs);
    expect(denied.allowed).toBe(false);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

    const allowed = await limiter.tryConsume(key, limit, windowMs);
    expect(allowed.allowed).toBe(true);
  });
});
