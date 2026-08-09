import type { PlanLimits, TenantPort } from "@harness/core";
import type { Pool } from "pg";
import { withTenantCtx } from "./db/tenant-transaction.js";

/**
 * PostgresTenantStore — Postgres implementation of TenantPort.
 *
 * All queries run inside withTenantCtx so RLS applies. The store does NOT
 * expose mutation operations — tenant creation goes through admin routes.
 */
export class PostgresTenantStore implements TenantPort {
  constructor(private readonly pool: Pool) {}

  /**
   * Returns plan limits for `tenantId`.
   *
   * Reads the tenant's `plan` field, then joins against `plan_limits`.
   * Throws if the tenant doesn't exist or its plan has no limit entry.
   */
  async getPlanLimits(tenantId: string): Promise<PlanLimits> {
    return withTenantCtx(this.pool, tenantId, async (client) => {
      const tenantResult = await client.query<{ plan: string }>(
        "SELECT plan FROM tenants WHERE id = $1",
        [tenantId],
      );
      if ((tenantResult.rowCount ?? 0) === 0) {
        throw new Error(`Tenant '${tenantId}' not found`);
      }
      const plan = tenantResult.rows[0]?.plan ?? "free";

      // plan_limits has a SELECT-all policy so it's visible from any tenant ctx
      const limitsResult = await client.query<{
        plan: string;
        max_concurrency: number;
        max_steps: number;
        monthly_runs: number;
        retention_days: number;
        max_custom_tools: number;
      }>("SELECT * FROM plan_limits WHERE plan = $1", [plan]);

      if ((limitsResult.rowCount ?? 0) === 0) {
        throw new Error(`Plan '${plan}' not found in plan_limits for tenant '${tenantId}'`);
      }
      const row = limitsResult.rows[0];
      if (!row) {
        throw new Error(`Plan '${plan}' not found in plan_limits for tenant '${tenantId}'`);
      }
      return {
        plan: row.plan,
        maxConcurrency: row.max_concurrency,
        maxSteps: row.max_steps,
        monthlyRuns: row.monthly_runs,
        retentionDays: row.retention_days,
        maxCustomTools: row.max_custom_tools,
      };
    });
  }

  /**
   * Counts workflows in `running` or `suspended` status for `tenantId`.
   * Used to enforce `max_concurrency` before starting a new workflow.
   */
  async getActiveConcurrency(tenantId: string): Promise<number> {
    return withTenantCtx(this.pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM workflows WHERE tenant_id = $1 AND status IN ('running', 'suspended')",
        [tenantId],
      );
      return Number(result.rows[0]?.count ?? "0");
    });
  }
}
