/**
 * RedisRateLimiter — sliding-window rate limiter backed by Redis.
 *
 * Pattern: Token Bucket (implemented as a sliding window counter via sorted set)
 *
 * Uses an atomic Lua script to prevent race conditions between check and
 * increment operations. Each key stores a Redis sorted set where members are
 * `<timestamp>-<uuid>` and scores are epoch milliseconds.
 *
 * Algorithm per request:
 *  1. ZREMRANGEBYSCORE: prune entries outside the window.
 *  2. ZCARD: count remaining entries.
 *  3. If count < limit: ZADD new entry, PEXPIRE, return allowed.
 *  4. Else: compute retry-after from the oldest entry, return denied.
 *
 * All four steps run atomically inside a single EVAL call.
 */

import type { RateLimitResult, RateLimiterPort } from "@harness/core";
import type { Redis } from "ioredis";

// Lua script executed atomically on the Redis server.
// Returns: [allowed (0|1), remaining, resetMs]
const LUA_SCRIPT = /* lua */ `
local key        = KEYS[1]
local limit      = tonumber(ARGV[1])
local windowMs   = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local member     = ARGV[4]

-- 1. Remove entries outside the current window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)

-- 2. Count current entries in the window.
local count = redis.call('ZCARD', key)

if count < limit then
  -- 3. Add this request and refresh TTL.
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return {1, limit - count - 1, 0}
else
  -- 4. Compute retry-after from the oldest entry.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = tonumber(oldest[2] or now)
  local resetMs = math.max(0, math.floor(oldestScore + windowMs - now))
  return {0, 0, resetMs}
end
`;

export class RedisRateLimiter implements RateLimiterPort {
  constructor(private readonly redis: Redis) {}

  async tryConsume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    // Use timestamp + random suffix to avoid member collisions.
    const member = `${now}-${Math.random().toString(36).slice(2)}`;

    const result = (await this.redis.eval(
      LUA_SCRIPT,
      1,
      key,
      String(limit),
      String(windowMs),
      String(now),
      member,
    )) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: result[1] ?? 0,
      resetMs: result[2] ?? 0,
    };
  }
}
