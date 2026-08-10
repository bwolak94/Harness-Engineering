/**
 * RateLimiterPort — Token Bucket / sliding-window rate limiting.
 *
 * Implementations:
 *  - InMemoryRateLimiter  (tests, single-process dev — not shared across instances)
 *  - RedisRateLimiter     (production — atomic Lua script on shared Redis)
 *
 * Key convention: `rl:<tenantId>:<METHOD>:<path>`
 * e.g. `rl:tenant-alpha:POST:/workflows`
 */

export interface RateLimitResult {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** Remaining tokens in the current window. */
  remaining: number;
  /** Milliseconds until the window resets (0 when allowed). */
  resetMs: number;
}

export interface RateLimiterPort {
  /**
   * Try to consume one token from the rate limit bucket.
   *
   * @param key      Unique bucket identifier (e.g. tenant + endpoint).
   * @param limit    Maximum requests allowed per window.
   * @param windowMs Rolling window size in milliseconds.
   */
  tryConsume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class NoopRateLimiterPort implements RateLimiterPort {
  async tryConsume(_key: string, limit: number): Promise<RateLimitResult> {
    return { allowed: true, remaining: limit - 1, resetMs: 0 };
  }
}
