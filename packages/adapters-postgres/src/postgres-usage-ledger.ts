/**
 * PostgresUsageLedger — UsageLedgerPort backed by the `usage_ledger` table.
 *
 * Pattern: Ledger (append-only fact table) + CQRS (feeds usage_rollups_daily)
 *
 * The table is partitioned by `ts` (daily partitions created by MULTI_TENANCY_SQL).
 * Inserts are idempotent via ON CONFLICT DO NOTHING on the composite primary key
 * (tenant_id, ts, id).
 *
 * Security: bypasses withTenantCtx because the worker process writes usage on
 * behalf of tenants without an active JWT session. Requires a role that can write
 * to all tenants' partitions (app_rw or BYPASSRLS in production).
 */

import type { UsageLedgerEntry, UsageLedgerPort } from "@harness/core";
import type { Pool } from "pg";

export class PostgresUsageLedger implements UsageLedgerPort {
  constructor(private readonly pool: Pool) {}

  async append(entries: UsageLedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Build a multi-row INSERT — one round-trip for the whole batch.
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let i = 1;

    for (const e of entries) {
      placeholders.push(
        `($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6})`,
      );
      values.push(e.id, e.tenantId, e.workflowId, e.ts, e.kind, e.qty, e.costUsd);
      i += 7;
    }

    await this.pool.query(
      `INSERT INTO usage_ledger (id, tenant_id, workflow_id, ts, kind, qty, cost_usd)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }
}
