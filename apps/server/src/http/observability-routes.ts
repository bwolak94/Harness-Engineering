/**
 * Observability routes — tenant-scoped usage and event-stream endpoints.
 *
 * All routes enforce authentication via requireAuth() and tenant isolation
 * via withTenantCtx() (sets app.tenant_id → RLS enforced).
 *
 * GET /observability/usage?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Returns daily rollups from usage_rollups_daily for the authenticated tenant.
 *
 * GET /observability/events/:workflowId
 *   Returns the ordered event log for a specific workflow.
 *   RLS ensures the tenant can only see their own workflows.
 */

import { withTenantCtx } from "@harness/adapters-postgres";
import { computeForecast } from "@harness/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, QueryResult } from "pg";
import { requireAuth } from "./auth-middleware.js";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

interface DailyRollupRow {
  day: string;
  runs: number;
  steps: number;
  tokens_in: string;
  tokens_out: string;
  cost_usd: string;
  tool_errors: number;
}

interface EventRow {
  id: string;
  seq: number;
  at: string;
  type: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerObservabilityRoutes(fastify: FastifyInstance, pool: Pool): void {
  // GET /observability/usage
  fastify.get("/observability/usage", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    const query = req.query as Record<string, string>;
    const from =
      query.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = query.to ?? new Date().toISOString().slice(0, 10);

    let result: QueryResult<DailyRollupRow>;
    try {
      result = await withTenantCtx(pool, ctx.tenantId, (client) =>
        client.query<DailyRollupRow>(
          `SELECT day, runs, steps, tokens_in, tokens_out, cost_usd, tool_errors
             FROM usage_rollups_daily
             WHERE day >= $1 AND day <= $2
             ORDER BY day DESC`,
          [from, to],
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ status: 500, title: "Internal Server Error", detail: msg });
      return;
    }

    reply.send({
      tenantId: ctx.tenantId,
      from,
      to,
      rows: result.rows.map((r) => ({
        day: r.day,
        runs: r.runs,
        steps: r.steps,
        tokensIn: Number(r.tokens_in),
        tokensOut: Number(r.tokens_out),
        costUsd: Number(r.cost_usd),
        toolErrors: r.tool_errors,
      })),
    });
  });

  // GET /observability/forecast
  // Returns a 30-day cost forecast computed via Holt's double exponential smoothing.
  // Query params:
  //   lookbackDays  - how many past days to use as training data (default: 30, min: 2)
  //   alpha         - level smoothing factor (default: 0.3)
  //   beta          - trend smoothing factor (default: 0.1)
  //   monthlyCap    - USD cap for alert triggering (optional)
  fastify.get("/observability/forecast", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    const query = req.query as Record<string, string>;
    const lookbackDays = Math.max(2, Number.parseInt(query.lookbackDays ?? "30", 10) || 30);
    const alpha = Number.parseFloat(query.alpha ?? "0.3") || 0.3;
    const beta = Number.parseFloat(query.beta ?? "0.1") || 0.1;
    const monthlyCap = query.monthlyCap ? Number.parseFloat(query.monthlyCap) : undefined;

    const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);

    let result: QueryResult<DailyRollupRow>;
    try {
      result = await withTenantCtx(pool, ctx.tenantId, (client) =>
        client.query<DailyRollupRow>(
          `SELECT day, runs, steps, tokens_in, tokens_out, cost_usd, tool_errors
             FROM usage_rollups_daily
             WHERE day >= $1 AND day <= $2
             ORDER BY day ASC`,
          [from, to],
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ status: 500, title: "Internal Server Error", detail: msg });
      return;
    }

    const history = result.rows.map((r) => ({
      date: typeof r.day === "string" ? r.day.slice(0, 10) : String(r.day),
      costUsd: Number(r.cost_usd),
    }));

    if (history.length < 2) {
      reply.status(422).send({
        status: 422,
        title: "Insufficient Data",
        detail: `Forecasting requires at least 2 days of history. Found ${history.length} day(s) in the requested window.`,
      });
      return;
    }

    let forecast: ReturnType<typeof computeForecast>;
    try {
      forecast = computeForecast(history, 30, {
        alpha,
        beta,
        ...(monthlyCap !== undefined && { monthlyCap }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(422).send({ status: 422, title: "Forecast Error", detail: msg });
      return;
    }

    reply.send({
      tenantId: ctx.tenantId,
      from,
      to,
      historyDays: history.length,
      level: forecast.level,
      trend: forecast.trend,
      residualStd: forecast.residualStd,
      projection30dUsd: forecast.projection30dUsd,
      alert: forecast.alert,
      monthlyCap: monthlyCap ?? null,
      next7: forecast.next7,
      next30: forecast.next30,
    });
  });

  // GET /observability/events/:workflowId
  fastify.get(
    "/observability/events/:workflowId",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireAuth(req, reply);
      if (!ctx) return;

      const { workflowId } = req.params as { workflowId: string };
      if (!workflowId) {
        reply
          .status(400)
          .send({ status: 400, title: "Bad Request", detail: "workflowId required" });
        return;
      }

      let result: QueryResult<EventRow>;
      try {
        result = await withTenantCtx(pool, ctx.tenantId, (client) =>
          client.query<EventRow>(
            `SELECT id, seq, at, type, payload
             FROM events
             WHERE workflow_id = $1
             ORDER BY seq ASC`,
            [workflowId],
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.status(500).send({ status: 500, title: "Internal Server Error", detail: msg });
        return;
      }

      reply.send({
        workflowId,
        tenantId: ctx.tenantId,
        events: result.rows,
      });
    },
  );
}
