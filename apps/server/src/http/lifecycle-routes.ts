/**
 * Lifecycle routes — tenant offboarding, GDPR export, and status transitions.
 *
 * All routes enforce authentication via requireAuth(). Admin/owner role required
 * for destructive operations.
 *
 * POST /tenants/:id/lifecycle         — lifecycle transitions
 *   body: { action: "suspend" | "reactivate" | "request-deletion" | "confirm-deletion" }
 *
 * GET  /tenants/:id/export            — GDPR Art. 20 data portability export (JSON)
 */

import { DeletionService } from "@harness/adapters-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAuth } from "./auth-middleware.js";
import { badRequest, notFound } from "./problem-details.js";
import { requireRole } from "./rbac.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const LifecycleActionBody = z.object({
  action: z.enum(["suspend", "reactivate", "request-deletion", "confirm-deletion"]),
});

// ---------------------------------------------------------------------------
// Status transitions allowed per action
// ---------------------------------------------------------------------------

const ALLOWED_FROM: Record<string, string[]> = {
  suspend: ["active"],
  reactivate: ["suspended", "limit_exceeded"],
  "request-deletion": ["active", "suspended", "limit_exceeded"],
  "confirm-deletion": ["deleting"],
};

const NEXT_STATUS: Record<string, string> = {
  suspend: "suspended",
  reactivate: "active",
  "request-deletion": "deleting",
  // confirm-deletion handled separately by DeletionService
};

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerLifecycleRoutes(fastify: FastifyInstance, pool: Pool): void {
  const deletionService = new DeletionService(pool);

  // POST /tenants/:id/lifecycle
  fastify.post<{ Params: { id: string } }>(
    "/tenants/:id/lifecycle",
    { preHandler: requireRole("admin") },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireAuth(req, reply);
      if (!ctx) return;

      const parsed = LifecycleActionBody.safeParse(req.body);
      if (!parsed.success) {
        return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
      }
      const { action } = parsed.data;
      const tenantId = req.params.id;

      // Verify the tenant exists and read current status.
      const tenantResult = await pool.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1",
        [tenantId],
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) return notFound(reply, req, `Tenant '${tenantId}' not found`);

      const allowed = ALLOWED_FROM[action] ?? [];
      if (!allowed.includes(tenant.status)) {
        return badRequest(
          reply,
          req,
          `Action '${action}' is not allowed from status '${tenant.status}'. Allowed from: ${allowed.join(", ")}`,
        );
      }

      if (action === "confirm-deletion") {
        try {
          const result = await deletionService.confirmDeletion(tenantId);
          reply.send({
            tenantId,
            status: "deleted",
            tablesCleared: result.tablesCleared.length,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          reply.status(500).send({ status: 500, title: "Deletion failed", detail: msg });
        }
        return;
      }

      if (action === "request-deletion") {
        await deletionService.requestDeletion(tenantId);
        reply.send({ tenantId, status: "deleting" });
        return;
      }

      // Simple status transitions: suspend / reactivate.
      const nextStatus = NEXT_STATUS[action];
      await pool.query("UPDATE tenants SET status = $1 WHERE id = $2", [nextStatus, tenantId]);
      reply.send({ tenantId, status: nextStatus });
    },
  );

  // GET /tenants/:id/export — GDPR data portability
  fastify.get<{ Params: { id: string } }>(
    "/tenants/:id/export",
    { preHandler: requireRole("admin") },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireAuth(req, reply);
      if (!ctx) return;

      const tenantId = req.params.id;

      // Ensure the caller belongs to the tenant they are exporting.
      if (ctx.tenantId !== tenantId) {
        reply.status(403).send({
          status: 403,
          title: "Forbidden",
          detail: "You can only export your own tenant data",
        });
        return;
      }

      try {
        const data = await deletionService.exportTenantData(tenantId);
        reply
          .header("Content-Type", "application/json")
          .header("Content-Disposition", `attachment; filename="tenant-${tenantId}-export.json"`)
          .send(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.status(500).send({ status: 500, title: "Export failed", detail: msg });
      }
    },
  );
}
