/**
 * PostgresBillingAdapter — BillingPort backed by usage_rollups_daily.
 *
 * Pattern: CQRS (read model) + Ledger (audit cross-check)
 *
 * All queries run inside withTenantCtx so RLS enforces tenant isolation.
 * The pool must be a connection authenticated as a role WITHOUT BYPASSRLS.
 */

import type { BillingPort, MonthlyInvoice, PlanViolation } from "@harness/core";
import type { Pool } from "pg";
import { withTenantCtx } from "./db/tenant-transaction.js";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RollupRow {
  runs: number;
  steps: number;
  tokens_in: string;
  tokens_out: string;
  cost_usd: string;
  tool_errors: number;
}

interface LedgerAggRow {
  runs: string;
  cost_usd: string;
}

interface PlanRow {
  plan: string;
  monthly_runs: number;
  max_concurrency: number;
}

interface TenantRow {
  status: string;
}

interface ConcurrencyRow {
  count: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PostgresBillingAdapter implements BillingPort {
  constructor(private readonly pool: Pool) {}

  async getMonthlyInvoice(tenantId: string, month: string): Promise<MonthlyInvoice> {
    const rows = await withTenantCtx(this.pool, tenantId, (client) =>
      client.query<RollupRow & { plan: string }>(
        `SELECT
           r.runs, r.steps, r.tokens_in, r.tokens_out, r.cost_usd, r.tool_errors,
           t.plan
         FROM usage_rollups_daily r
         JOIN tenants t ON t.id = r.tenant_id
         WHERE r.tenant_id = $1
           AND to_char(r.day, 'YYYY-MM') = $2`,
        [tenantId, month],
      ),
    );

    const plan = rows.rows[0]?.plan ?? "free";
    let runs = 0;
    let steps = 0;
    let tokensIn = 0n;
    let tokensOut = 0n;
    let costUsd = 0;
    let toolErrors = 0;
    for (const r of rows.rows) {
      runs += r.runs;
      steps += r.steps;
      tokensIn += BigInt(r.tokens_in);
      tokensOut += BigInt(r.tokens_out);
      costUsd += Number(r.cost_usd);
      toolErrors += r.tool_errors;
    }
    return { tenantId, month, plan, runs, steps, tokensIn, tokensOut, costUsd, toolErrors };
  }

  async verifyInvoiceWithLedger(
    tenantId: string,
    month: string,
  ): Promise<{ costDeltaUsd: number; runsDelta: number }> {
    // Aggregate directly from usage_ledger (raw, no CQRS).
    const ledgerResult = await withTenantCtx(this.pool, tenantId, (client) =>
      client.query<LedgerAggRow>(
        `SELECT
           COUNT(*) FILTER (WHERE kind = 'run')         AS runs,
           COALESCE(SUM(cost_usd) FILTER (WHERE kind = 'run'), 0) AS cost_usd
         FROM usage_ledger
         WHERE tenant_id = $1
           AND to_char(ts, 'YYYY-MM') = $2`,
        [tenantId, month],
      ),
    );

    const ledger = ledgerResult.rows[0];
    const invoice = await this.getMonthlyInvoice(tenantId, month);

    const ledgerCost = Number(ledger?.cost_usd ?? 0);
    const ledgerRuns = Number(ledger?.runs ?? 0);

    return {
      costDeltaUsd: Math.abs(invoice.costUsd - ledgerCost),
      runsDelta: Math.abs(invoice.runs - ledgerRuns),
    };
  }

  async getMonthlyRunCount(tenantId: string): Promise<number> {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const result = await withTenantCtx(this.pool, tenantId, (client) =>
      client.query<{ runs: string }>(
        `SELECT COALESCE(SUM(runs), 0) AS runs
         FROM usage_rollups_daily
         WHERE tenant_id = $1
           AND to_char(day, 'YYYY-MM') = $2`,
        [tenantId, month],
      ),
    );

    return Number(result.rows[0]?.runs ?? 0);
  }

  async checkPlanLimits(tenantId: string): Promise<PlanViolation | null> {
    // Check tenant status first.
    const tenantResult = await withTenantCtx(this.pool, tenantId, (client) =>
      client.query<TenantRow>("SELECT status FROM tenants WHERE id = $1", [tenantId]),
    );
    const tenantStatus = tenantResult.rows[0]?.status ?? "active";

    if (tenantStatus === "deleting" || tenantStatus === "deleted") {
      return { kind: "deleting", limit: 0, current: 0 };
    }
    if (tenantStatus === "suspended" || tenantStatus === "limit_exceeded") {
      return { kind: "suspended", limit: 0, current: 0 };
    }

    // Load plan limits.
    const planResult = await withTenantCtx(this.pool, tenantId, (client) =>
      client.query<PlanRow>(
        `SELECT pl.plan, pl.monthly_runs, pl.max_concurrency
         FROM plan_limits pl
         JOIN tenants t ON t.plan = pl.plan
         WHERE t.id = $1`,
        [tenantId],
      ),
    );
    const limits = planResult.rows[0];
    if (!limits) return null;

    // Check monthly run limit.
    const monthlyRuns = await this.getMonthlyRunCount(tenantId);
    if (monthlyRuns >= limits.monthly_runs) {
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return {
        kind: "monthly_runs",
        limit: limits.monthly_runs,
        current: monthlyRuns,
        retryAfter: nextMonth.toISOString().slice(0, 10),
      };
    }

    // Check active concurrency.
    const concurrencyResult = await withTenantCtx(this.pool, tenantId, (client) =>
      client.query<ConcurrencyRow>(
        `SELECT COUNT(*) AS count
         FROM workflows
         WHERE tenant_id = $1
           AND status IN ('running', 'suspended')`,
        [tenantId],
      ),
    );
    const activeConcurrency = Number(concurrencyResult.rows[0]?.count ?? 0);
    if (activeConcurrency >= limits.max_concurrency) {
      return {
        kind: "concurrency",
        limit: limits.max_concurrency,
        current: activeConcurrency,
      };
    }

    return null;
  }
}
