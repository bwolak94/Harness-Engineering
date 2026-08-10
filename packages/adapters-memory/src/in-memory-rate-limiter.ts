/**
 * InMemoryRateLimiter — sliding-window counter for tests and single-process dev.
 *
 * Stores request timestamps per key. Not safe for multi-process deployments;
 * use RedisRateLimiter in production.
 */

import type { RateLimitResult, RateLimiterPort } from "@harness/core";

export class InMemoryRateLimiter implements RateLimiterPort {
  /** key → sorted list of request timestamps (epoch ms). */
  private readonly windows = new Map<string, number[]>();

  async tryConsume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create bucket, pruning expired entries.
    let timestamps = this.windows.get(key) ?? [];
    timestamps = timestamps.filter((t) => t > windowStart);

    if (timestamps.length >= limit) {
      // Oldest timestamp determines when a slot opens.
      const oldest = timestamps[0] ?? now;
      const resetMs = Math.max(0, oldest + windowMs - now);
      this.windows.set(key, timestamps);
      return { allowed: false, remaining: 0, resetMs };
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return { allowed: true, remaining: limit - timestamps.length, resetMs: 0 };
  }

  /** Test helper — clear all buckets. */
  clear(): void {
    this.windows.clear();
  }

  /** Test helper — return current count for a key. */
  countFor(key: string): number {
    return this.windows.get(key)?.length ?? 0;
  }
}
