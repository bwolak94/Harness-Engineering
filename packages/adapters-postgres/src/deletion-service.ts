/**
 * DeletionService — cascading tenant deletion for GDPR Art. 17 "right to erasure".
 *
 * Pattern: Saga (compensating transactions) + Soft delete (status transitions)
 *
 * Deletion flow:
 *  1. Mark tenant as 'deleting' — prevents new workflow starts.
 *  2. Delete all data-plane rows in reverse FK dependency order.
 *  3. Delete all control-plane rows.
 *  4. Stub calls to blob store and KMS (implemented when those adapters ship).
 *  5. Hard-delete the tenant row (or set status='deleted' for audit trail).
 *
 * Idempotency: each step checks the current state before acting, so re-running
 * after a partial failure is safe.
 *
 * Security: uses the direct pool (BYPASSRLS) because deletion must bypass RLS —
 * the tenant row itself would block queries once status is 'deleting'.
 */

import type { Pool } from "pg";

export interface DeletionResult {
  tenantId: string;
  tablesCleared: string[];
  /** Counts of rows deleted per table (best-effort; partitioned tables show 0). */
  rowsDeleted: Record<string, number>;
}

// Tables in dependency order (children first).
// Tables that exist in the current schema (applyMultiTenancy DDL).
// outbox, idempotency_records, and blob_refs are planned in the data model
// but not yet DDL'd — add them here when their migrations land.
const DATA_PLANE_TABLES = [
  "approvals",
  "step_leases",
  "job_queue",
  "snapshots",
  "events",
  "workflows",
  "usage_rollups_daily",
  // usage_ledger is partitioned — Postgres routes deletes to the right partitions.
  "usage_ledger",
] as const;

// secrets is created by applySecrets() (0003_secrets.sql), not applyMultiTenancy().
// Add it back here once that migration is applied unconditionally at startup.
const CONTROL_PLANE_TABLES = [
  "tenant_deks",
  "platform_api_keys",
  "tool_versions",
  "tool_definitions",
  "mcp_servers",
  "agents",
  "policies",
  "memberships",
  "users",
] as const;

export class DeletionService {
  constructor(private readonly pool: Pool) {}

  /**
   * Mark the tenant as 'deleting'. New workflow starts will be rejected.
   * Idempotent — safe to call multiple times.
   */
  async requestDeletion(tenantId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenants
       SET status = 'deleting'
       WHERE id = $1 AND status NOT IN ('deleting', 'deleted')`,
      [tenantId],
    );
  }

  /**
   * Cascade-delete all tenant data and remove the tenant row.
   * Must be called after requestDeletion() and after all in-flight
   * workflows have completed (caller's responsibility to verify).
   */
  async confirmDeletion(tenantId: string): Promise<DeletionResult> {
    const tablesCleared: string[] = [];
    const rowsDeleted: Record<string, number> = {};

    // Step 1 — ensure the tenant is in 'deleting' state.
    const statusResult = await this.pool.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [tenantId],
    );
    const status = statusResult.rows[0]?.status;
    if (!status) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }
    if (status === "deleted") {
      return { tenantId, tablesCleared: [], rowsDeleted: {} };
    }
    if (status !== "deleting") {
      throw new Error(
        `Tenant '${tenantId}' must be in 'deleting' state before confirming deletion (current: ${status})`,
      );
    }

    // Step 2 — delete data-plane rows.
    for (const table of DATA_PLANE_TABLES) {
      const result = await this.pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      tablesCleared.push(table);
      rowsDeleted[table] = result.rowCount ?? 0;
    }

    // Step 3 — delete control-plane rows.
    for (const table of CONTROL_PLANE_TABLES) {
      const result = await this.pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      tablesCleared.push(table);
      rowsDeleted[table] = result.rowCount ?? 0;
    }

    // Step 4 — stub: notify blob store + KMS.
    // BlobStorePort.deleteAllForTenant(tenantId) — no-op until T20
    // KmsPort.deleteKey(tenantId) — no-op until KMS adapter ships
    console.info(`[deletion] blob store and KMS deletion for tenant '${tenantId}' pending (stubs)`);

    // Step 5 — hard-delete the tenant row (preserves audit trail in the
    // deletion log if one exists; here we set status='deleted' instead
    // of removing the row so the ADR audit trail still works).
    await this.pool.query("UPDATE tenants SET status = 'deleted' WHERE id = $1", [tenantId]);
    tablesCleared.push("tenants");

    return { tenantId, tablesCleared, rowsDeleted };
  }

  /**
   * Export all tenant data as a structured JSON object for GDPR Art. 20
   * "right to data portability".
   *
   * Returns a plain object — callers stream it as JSON to the HTTP response.
   * All queries bypass RLS (direct pool) because the tenant row may be
   * in 'deleting' state and RLS would block reads.
   */
  async exportTenantData(tenantId: string): Promise<Record<string, unknown>> {
    const all: Record<string, unknown[]> = {};

    const allTables = [...DATA_PLANE_TABLES, ...CONTROL_PLANE_TABLES, "tenants"] as const;

    for (const table of allTables) {
      const result = await this.pool.query(
        `SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY 1`,
        [tenantId],
      );
      all[table] = result.rows;
    }

    return {
      exportedAt: new Date().toISOString(),
      tenantId,
      tables: all,
    };
  }
}
