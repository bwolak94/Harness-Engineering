/**
 * PostgresJobQueue — QueuePort backed by the `job_queue` table.
 *
 * Pattern: Competing Consumers
 *
 * Key behaviours:
 *  - `FOR UPDATE SKIP LOCKED` ensures each job is claimed by exactly one worker.
 *  - Idempotent enqueue: `ON CONFLICT (workflow_id) DO NOTHING`.
 *  - Bulkhead: before committing the claim, checks plan_limits.max_concurrency for
 *    the candidate job's tenant; returns null if the tenant is at its limit.
 *  - Exponential backoff: `nack()` increments attempts and sets `run_after`.
 *  - Task payload stored as JSONB; restored as TaskPacket on dequeue.
 *
 * Security: this adapter uses direct pool queries (bypasses withTenantCtx /
 * app_rw role) because the worker must see jobs across all tenants.
 * In production the worker must connect with a role that has BYPASSRLS.
 */

import { randomUUID } from "node:crypto";
import type { TaskPacket } from "@harness/contracts";
import type { QueueJob, QueuePort } from "@harness/core";
import type { Pool } from "pg";

export class PostgresJobQueue implements QueuePort {
  constructor(private readonly pool: Pool) {}

  async enqueue(tenantId: string, task: TaskPacket, priority = 0): Promise<void> {
    await this.pool.query(
      `INSERT INTO job_queue (id, tenant_id, workflow_id, task, priority, run_after, attempts)
       VALUES ($1, $2, $3, $4, $5, NOW(), 0)
       ON CONFLICT (workflow_id) DO NOTHING`,
      [randomUUID(), tenantId, task.id, JSON.stringify(task), priority],
    );
  }

  async dequeue(workerId: string): Promise<QueueJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Claim the next available job across all tenants.
      // SKIP LOCKED: other workers concurrently dequeuing will skip rows locked by us.
      const result = await client.query<{
        id: string;
        tenant_id: string;
        task: TaskPacket;
        priority: number;
        attempts: number;
      }>(
        `SELECT id, tenant_id, task, priority, attempts
         FROM   job_queue
         WHERE  locked_by IS NULL
           AND  run_after <= NOW()
         ORDER  BY priority DESC, run_after ASC
         FOR UPDATE SKIP LOCKED
         LIMIT  1`,
      );

      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }

      // Bulkhead check: how many jobs are actively locked for this tenant?
      const bulkheadResult = await client.query<{ active: string; max_concurrency: string }>(
        `SELECT COUNT(jq.id)                    AS active,
                COALESCE(pl.max_concurrency, 5)  AS max_concurrency
         FROM   job_queue jq
         LEFT   JOIN tenants    t  ON t.id    = jq.tenant_id
         LEFT   JOIN plan_limits pl ON pl.plan = t.plan
         WHERE  jq.tenant_id   = $1
           AND  jq.locked_by   IS NOT NULL
           AND  jq.locked_until > NOW()
         GROUP  BY pl.max_concurrency`,
        [row.tenant_id],
      );

      const active = Number(bulkheadResult.rows[0]?.active ?? 0);
      const maxConcurrency = Number(bulkheadResult.rows[0]?.max_concurrency ?? 5);

      if (active >= maxConcurrency) {
        // Tenant is at its concurrency limit; defer the job by a few seconds.
        await client.query(
          `UPDATE job_queue
           SET    run_after = NOW() + INTERVAL '5 seconds'
           WHERE  id = $1`,
          [row.id],
        );
        await client.query("COMMIT");
        return null;
      }

      // Lock the job for this worker.
      await client.query(
        `UPDATE job_queue
         SET    locked_by = $1, locked_until = NOW() + INTERVAL '5 minutes'
         WHERE  id = $2`,
        [workerId, row.id],
      );

      await client.query("COMMIT");
      return {
        id: row.id,
        tenantId: row.tenant_id,
        task: row.task,
        priority: row.priority,
        attempts: row.attempts,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async ack(jobId: string): Promise<void> {
    await this.pool.query("DELETE FROM job_queue WHERE id = $1", [jobId]);
  }

  async nack(jobId: string, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET    locked_by    = NULL,
              locked_until = NULL,
              attempts     = attempts + 1,
              run_after    = NOW() + ($1 * INTERVAL '1 millisecond')
       WHERE  id = $2`,
      [delayMs, jobId],
    );
  }
}
