/**
 * Billing routes — tenant-scoped invoice and usage endpoints.
 *
 * All routes enforce authentication via requireAuth() and RLS via withTenantCtx()
 * inside PostgresBillingAdapter.
 *
 * GET /billing/invoice/:month   — reproducible monthly invoice (YYYY-MM)
 * GET /billing/usage            — current month running total
 * GET /billing/check            — plan-limit check (used before starting a workflow)
 */

import { PostgresBillingAdapter } from "@harness/adapters-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { requireAuth } from "./auth-middleware.js";
import { badRequest } from "./problem-details.js";

// Month format: YYYY-MM
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export function registerBillingRoutes(fastify: FastifyInstance, pool: Pool): void {
  const billing = new PostgresBillingAdapter(pool);

  // GET /billing/invoice/:month
  fastify.get<{ Params: { month: string } }>(
    "/billing/invoice/:month",
    async (req: FastifyRequest<{ Params: { month: string } }>, reply: FastifyReply) => {
      const ctx = requireAuth(req, reply);
      if (!ctx) return;

      const { month } = req.params;
      if (!MONTH_RE.test(month)) {
        return badRequest(reply, req, "month must be in YYYY-MM format");
      }

      try {
        const invoice = await billing.getMonthlyInvoice(ctx.tenantId, month);
        reply.send({
          ...invoice,
          tokensIn: invoice.tokensIn.toString(),
          tokensOut: invoice.tokensOut.toString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.status(500).send({ status: 500, title: "Internal Server Error", detail: msg });
      }
    },
  );

  // GET /billing/usage — current month
  fastify.get("/billing/usage", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    try {
      const invoice = await billing.getMonthlyInvoice(ctx.tenantId, month);
      const monthlyRuns = await billing.getMonthlyRunCount(ctx.tenantId);
      reply.send({
        month,
        runs: monthlyRuns,
        costUsd: invoice.costUsd,
        tokensIn: invoice.tokensIn.toString(),
        tokensOut: invoice.tokensOut.toString(),
        toolErrors: invoice.toolErrors,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ status: 500, title: "Internal Server Error", detail: msg });
    }
  });

  // GET /billing/check — returns plan violation or null
  fastify.get("/billing/check", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    try {
      const violation = await billing.checkPlanLimits(ctx.tenantId);
      if (violation) {
        reply.status(429).send({
          status: 429,
          title: "Plan limit exceeded",
          detail: `${violation.kind} limit reached (${violation.current}/${violation.limit})`,
          violation,
        });
        return;
      }
      reply.send({ allowed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ status: 500, title: "Internal Server Error", detail: msg });
    }
  });
}
