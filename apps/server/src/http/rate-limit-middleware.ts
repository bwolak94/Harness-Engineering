/**
 * rateLimitMiddleware — per-tenant request rate limiter.
 *
 * Consumes one token per incoming request using the injected RateLimiterPort.
 * Returns 429 with Retry-After when the tenant has exceeded their RPM limit.
 * Unauthenticated requests (no tenantContext) are not rate-limited here —
 * the auth middleware will reject them with 401 before business logic runs.
 */

import type { RateLimiterPort } from "@harness/core";
import type { TenantContext } from "@harness/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function registerRateLimitMiddleware(
  fastify: FastifyInstance,
  rateLimiter: RateLimiterPort,
  limitRpm: number,
): void {
  const windowMs = 60_000; // 1 minute sliding window

  fastify.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = (req as FastifyRequest & { tenantContext?: TenantContext }).tenantContext;
    if (!ctx) return; // not authenticated — auth middleware will reject

    const key = `rate:${ctx.tenantId}`;
    const result = await rateLimiter.tryConsume(key, limitRpm, windowMs);

    reply.header("X-RateLimit-Limit", String(limitRpm));
    reply.header("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.resetMs / 1000);
      reply.header("Retry-After", String(retryAfterSec));
      reply.status(429).send({
        status: 429,
        title: "Too Many Requests",
        detail: `Rate limit of ${limitRpm} requests/minute exceeded. Retry after ${retryAfterSec}s.`,
      });
    }
  });
}
