import { type MemberRole, type TenantContext, hasRole } from "@harness/core";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * requireRole — Fastify preHandler factory.
 *
 * Returns a hook that:
 *  1. Checks req.tenantContext is present (401 if missing)
 *  2. Checks the caller's role satisfies the minimum required role (403 if not)
 *
 * Usage:
 *   fastify.post("/tenants", { preHandler: requireRole("admin") }, handler)
 */
export function requireRole(
  minimum: MemberRole,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const ctx = (req as FastifyRequest & { tenantContext?: TenantContext }).tenantContext;
    if (!ctx) {
      reply
        .status(401)
        .send({ status: 401, title: "Unauthorized", detail: "Authentication required" });
      return;
    }
    if (!hasRole(ctx.role, minimum)) {
      reply.status(403).send({
        status: 403,
        title: "Forbidden",
        detail: `Requires role '${minimum}' or higher; caller has '${ctx.role}'`,
      });
    }
  };
}
