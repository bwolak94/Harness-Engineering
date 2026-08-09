/**
 * PostgresStepLease integration tests (T17 Definition of Done).
 *
 * Requires Testcontainers + Docker.
 *
 * DoD coverage:
 *  ✅ acquire returns true and grants the lease
 *  ✅ acquire returns false when another worker holds a valid lease
 *  ✅ acquire returns true when the existing lease has expired (take-over)
 *  ✅ re-acquire by same worker returns true
 *  ✅ heartbeat extends lease_until
 *  ✅ release deletes the lease row
 *  ✅ reapExpired removes expired leases and resets job_queue locked_by
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "../db/client.js";
import { applyMultiTenancy } from "../db/multi-tenancy.js";
import { PostgresStepLease } from "../postgres-step-lease.js";

// ---------------------------------------------------------------------------
// Docker availability guard
// ---------------------------------------------------------------------------

let dockerAvailable = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerAvailable = true;
} catch {
  // Docker not available — suite will be skipped.
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)("PostgresStepLease (Testcontainers)", () => {
  let pool: Pool;
  let lease: PostgresStepLease;
  let tenantId: string;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    await applyMultiTenancy(pool);

    tenantId = randomUUID();
    await pool.query(
      "INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [tenantId, "Test Tenant", "free"],
    );

    lease = new PostgresStepLease(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("acquire grants a new lease and returns true", async () => {
    const workflowId = randomUUID();
    const result = await lease.acquire(workflowId, tenantId, "worker-1", 60_000);
    expect(result).toBe(true);

    const row = await pool.query("SELECT worker_id FROM step_leases WHERE workflow_id = $1", [
      workflowId,
    ]);
    expect(row.rows[0]?.worker_id).toBe("worker-1");

    await lease.release(workflowId, "worker-1");
  });

  it("acquire returns false when another worker holds a valid lease", async () => {
    const workflowId = randomUUID();
    await lease.acquire(workflowId, tenantId, "worker-1", 60_000);

    const result = await lease.acquire(workflowId, tenantId, "worker-2", 60_000);
    expect(result).toBe(false);

    await lease.release(workflowId, "worker-1");
  });

  it("re-acquire by the same worker returns true", async () => {
    const workflowId = randomUUID();
    await lease.acquire(workflowId, tenantId, "worker-1", 60_000);

    const result = await lease.acquire(workflowId, tenantId, "worker-1", 60_000);
    expect(result).toBe(true);

    await lease.release(workflowId, "worker-1");
  });

  it("acquire takes over an expired lease", async () => {
    const workflowId = randomUUID();

    // Insert an already-expired lease directly.
    await pool.query(
      `INSERT INTO step_leases (workflow_id, tenant_id, worker_id, lease_until, heartbeat_at)
       VALUES ($1, $2, 'old-worker', NOW() - INTERVAL '1 second', NOW() - INTERVAL '10 seconds')`,
      [workflowId, tenantId],
    );

    const result = await lease.acquire(workflowId, tenantId, "new-worker", 60_000);
    expect(result).toBe(true);

    const row = await pool.query("SELECT worker_id FROM step_leases WHERE workflow_id = $1", [
      workflowId,
    ]);
    expect(row.rows[0]?.worker_id).toBe("new-worker");

    await lease.release(workflowId, "new-worker");
  });

  it("heartbeat extends lease_until and returns true", async () => {
    const workflowId = randomUUID();
    await lease.acquire(workflowId, tenantId, "worker-1", 10_000);

    const before = await pool.query<{ lease_until: Date }>(
      "SELECT lease_until FROM step_leases WHERE workflow_id = $1",
      [workflowId],
    );

    // Extend by 60 seconds
    const extended = await lease.heartbeat(workflowId, "worker-1", 60_000);
    expect(extended).toBe(true);

    const after = await pool.query<{ lease_until: Date }>(
      "SELECT lease_until FROM step_leases WHERE workflow_id = $1",
      [workflowId],
    );

    expect(after.rows[0]!.lease_until.getTime()).toBeGreaterThan(
      before.rows[0]!.lease_until.getTime(),
    );

    await lease.release(workflowId, "worker-1");
  });

  it("heartbeat returns false for wrong worker_id", async () => {
    const workflowId = randomUUID();
    await lease.acquire(workflowId, tenantId, "worker-1", 60_000);

    const result = await lease.heartbeat(workflowId, "worker-2", 60_000);
    expect(result).toBe(false);

    await lease.release(workflowId, "worker-1");
  });

  it("release removes the lease row", async () => {
    const workflowId = randomUUID();
    await lease.acquire(workflowId, tenantId, "worker-1", 60_000);
    await lease.release(workflowId, "worker-1");

    const row = await pool.query("SELECT workflow_id FROM step_leases WHERE workflow_id = $1", [
      workflowId,
    ]);
    expect(row.rows).toHaveLength(0);
  });

  it("reapExpired removes stale leases and resets job_queue locked_by", async () => {
    const workflowId = randomUUID();

    // Insert an expired lease directly.
    await pool.query(
      `INSERT INTO step_leases (workflow_id, tenant_id, worker_id, lease_until, heartbeat_at)
       VALUES ($1, $2, 'crashed-worker', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '10 minutes')`,
      [workflowId, tenantId],
    );

    // Insert a corresponding job_queue row in locked state.
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO job_queue (id, tenant_id, workflow_id, task, locked_by, locked_until)
       VALUES ($1, $2, $3, '{}', 'crashed-worker', NOW() + INTERVAL '1 hour')`,
      [jobId, tenantId, workflowId],
    );

    const reaped = await lease.reapExpired();
    expect(reaped).toBeGreaterThanOrEqual(1);

    // Lease should be gone
    const leaseRow = await pool.query("SELECT * FROM step_leases WHERE workflow_id = $1", [
      workflowId,
    ]);
    expect(leaseRow.rows).toHaveLength(0);

    // Job should be unlocked and re-eligible
    const jobRow = await pool.query<{ locked_by: string | null; attempts: number }>(
      "SELECT locked_by, attempts FROM job_queue WHERE id = $1",
      [jobId],
    );
    expect(jobRow.rows[0]?.locked_by).toBeNull();
    expect(jobRow.rows[0]?.attempts).toBe(1);

    // Clean up
    await pool.query("DELETE FROM job_queue WHERE id = $1", [jobId]);
  });
});
