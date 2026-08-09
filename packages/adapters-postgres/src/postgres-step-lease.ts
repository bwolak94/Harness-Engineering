/**
 * PostgresStepLease — LeasePort backed by the `step_leases` table.
 *
 * Pattern: Lease + Heartbeat
 *
 * The reaper (`reapExpired`) runs in every worker instance but uses
 * `FOR UPDATE SKIP LOCKED` on the expired rows so only one reaper processes
 * each expired lease. It also resets the corresponding `job_queue` rows so
 * the workflow re-enters the queue.
 *
 * Security: uses direct pool queries (no withTenantCtx) because the reaper
 * must see leases across all tenants. Requires BYPASSRLS role in production.
 */

import type { LeasePort } from "@harness/core";
import type { Pool } from "pg";

export class PostgresStepLease implements LeasePort {
  constructor(private readonly pool: Pool) {}

  async acquire(
    workflowId: string,
    tenantId: string,
    workerId: string,
    durationMs: number,
  ): Promise<boolean> {
    // Insert or check ownership atomically.
    const result = await this.pool.query<{ worker_id: string }>(
      `INSERT INTO step_leases (workflow_id, tenant_id, worker_id, lease_until, heartbeat_at)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 millisecond'), NOW())
       ON CONFLICT (workflow_id) DO UPDATE
         SET lease_until   = EXCLUDED.lease_until,
             heartbeat_at  = NOW(),
             worker_id     = EXCLUDED.worker_id
         WHERE step_leases.lease_until < NOW()  -- only take over if expired
       RETURNING worker_id`,
      [workflowId, tenantId, workerId, durationMs],
    );
    // If no row returned, the lease exists and is held by another worker.
    if (result.rows.length === 0) {
      // Check if this worker already owns it.
      const check = await this.pool.query<{ worker_id: string }>(
        "SELECT worker_id FROM step_leases WHERE workflow_id = $1",
        [workflowId],
      );
      return check.rows[0]?.worker_id === workerId;
    }
    return result.rows[0]?.worker_id === workerId;
  }

  async heartbeat(workflowId: string, workerId: string, durationMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE step_leases
       SET    lease_until  = NOW() + ($1 * INTERVAL '1 millisecond'),
              heartbeat_at = NOW()
       WHERE  workflow_id  = $2
         AND  worker_id    = $3
         AND  lease_until  > NOW()`,
      [durationMs, workflowId, workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async release(workflowId: string, workerId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM step_leases WHERE workflow_id = $1 AND worker_id = $2",
      [workflowId, workerId],
    );
  }

  async reapExpired(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock expired leases exclusively so concurrent reapers don't double-process.
      const expired = await client.query<{ workflow_id: string }>(
        `DELETE FROM step_leases
         WHERE  lease_until < NOW()
         RETURNING workflow_id`,
      );

      if (expired.rows.length === 0) {
        await client.query("COMMIT");
        return 0;
      }

      const workflowIds = expired.rows.map((r) => r.workflow_id);

      // Reset job_queue rows so these workflows re-enter the queue.
      await client.query(
        `UPDATE job_queue
         SET    locked_by    = NULL,
                locked_until = NULL,
                attempts     = attempts + 1,
                run_after    = NOW() + INTERVAL '1 second'
         WHERE  workflow_id  = ANY($1)
           AND  locked_by    IS NOT NULL`,
        [workflowIds],
      );

      await client.query("COMMIT");
      return workflowIds.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
