/**
 * PostgresJobQueue integration tests (T17 Definition of Done).
 *
 * Requires Testcontainers + Docker.
 *
 * DoD coverage:
 *  ✅ enqueue is idempotent on workflow_id
 *  ✅ dequeue respects priority ordering
 *  ✅ dequeue respects run_after (not yet eligible jobs are skipped)
 *  ✅ bulkhead: dequeue returns null when tenant is at max_concurrency
 *  ✅ ack removes the job
 *  ✅ nack increments attempts and postpones run_after
 *  ✅ dequeue returns null when queue is empty
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TaskPacket } from "@harness/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "../db/client.js";
import { applyMultiTenancy } from "../db/multi-tenancy.js";
import { PostgresJobQueue } from "../postgres-job-queue.js";

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
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id = randomUUID()): TaskPacket {
  return {
    id,
    goal: "test goal",
    budget: { maxTokens: 1000, maxSteps: 10, maxWallClockMs: 10_000, maxCostUsd: 1 },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)("PostgresJobQueue (Testcontainers)", () => {
  let pool: Pool;
  let queue: PostgresJobQueue;
  let tenantId: string;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    await applyMultiTenancy(pool);

    // Insert a tenant and plan_limits row so bulkhead checks work.
    tenantId = randomUUID();
    await pool.query(
      "INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [tenantId, "Test Tenant", "free"],
    );
    await pool.query(
      "INSERT INTO plan_limits (plan, max_concurrency) VALUES ($1, $2) ON CONFLICT (plan) DO UPDATE SET max_concurrency = $2",
      ["free", 2],
    );

    queue = new PostgresJobQueue(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("enqueue inserts a job and dequeue returns it", async () => {
    const task = makeTask();
    await queue.enqueue(tenantId, task);

    const job = await queue.dequeue("worker-1");
    expect(job).not.toBeNull();
    if (!job) return;
    expect(job.task.id).toBe(task.id);
    expect(job.tenantId).toBe(tenantId);
    expect(job.attempts).toBe(0);

    // Clean up
    await queue.ack(job.id);
  });

  it("enqueue is idempotent on workflow_id", async () => {
    const task = makeTask();
    await queue.enqueue(tenantId, task);
    await queue.enqueue(tenantId, task); // second call must not throw or duplicate

    const job = await queue.dequeue("worker-2");
    expect(job).not.toBeNull();
    if (!job) return;

    // Only one row should exist — dequeue the only copy
    const second = await queue.dequeue("worker-3");
    expect(second).toBeNull(); // no duplicate

    await queue.ack(job.id);
  });

  it("dequeue returns null when queue is empty", async () => {
    const result = await queue.dequeue("worker-1");
    expect(result).toBeNull();
  });

  it("dequeue respects priority (higher priority first)", async () => {
    const lowTask = makeTask();
    const highTask = makeTask();

    await queue.enqueue(tenantId, lowTask, 0);
    await queue.enqueue(tenantId, highTask, 10);

    const first = await queue.dequeue("worker-1");
    expect(first?.task.id).toBe(highTask.id);
    if (!first) return;

    const second = await queue.dequeue("worker-2");
    expect(second?.task.id).toBe(lowTask.id);
    if (!second) return;

    await queue.ack(first.id);
    await queue.ack(second.id);
  });

  it("dequeue skips jobs where run_after is in the future", async () => {
    // Insert a job directly with run_after far in the future.
    const futureTask = makeTask();
    await pool.query(
      `INSERT INTO job_queue (id, tenant_id, workflow_id, task, priority, run_after, attempts)
       VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '1 hour', 0)`,
      [randomUUID(), tenantId, futureTask.id, JSON.stringify(futureTask)],
    );

    const job = await queue.dequeue("worker-1");
    expect(job).toBeNull(); // future job not eligible

    // Clean up
    await pool.query("DELETE FROM job_queue WHERE workflow_id = $1", [futureTask.id]);
  });

  it("ack removes the job from the queue", async () => {
    const task = makeTask();
    await queue.enqueue(tenantId, task);

    const job = await queue.dequeue("worker-1");
    expect(job).not.toBeNull();
    if (!job) return;

    await queue.ack(job.id);

    const after = await pool.query("SELECT id FROM job_queue WHERE id = $1", [job.id]);
    expect(after.rows).toHaveLength(0);
  });

  it("nack increments attempts and postpones run_after", async () => {
    const task = makeTask();
    await queue.enqueue(tenantId, task);

    const job = await queue.dequeue("worker-1");
    expect(job).not.toBeNull();
    if (!job) return;

    await queue.nack(job.id, 5_000);

    const row = await pool.query<{ attempts: number; run_after: Date; locked_by: string | null }>(
      "SELECT attempts, run_after, locked_by FROM job_queue WHERE id = $1",
      [job.id],
    );
    expect(row.rows[0]?.attempts).toBe(1);
    expect(row.rows[0]?.locked_by).toBeNull();
    expect(row.rows[0]?.run_after.getTime()).toBeGreaterThan(Date.now());

    // Clean up
    await pool.query("DELETE FROM job_queue WHERE id = $1", [job.id]);
  });

  it("bulkhead: dequeue returns null when tenant is at max_concurrency", async () => {
    // max_concurrency for 'free' plan is 2 (set in beforeAll)
    const taskA = makeTask();
    const taskB = makeTask();
    const taskC = makeTask();

    await queue.enqueue(tenantId, taskA);
    await queue.enqueue(tenantId, taskB);
    await queue.enqueue(tenantId, taskC);

    // Claim first two — tenant now has 2 active locked jobs
    const jobA = await queue.dequeue("worker-A");
    const jobB = await queue.dequeue("worker-B");
    expect(jobA).not.toBeNull();
    expect(jobB).not.toBeNull();
    if (!jobA || !jobB) return;

    // Third dequeue must hit the bulkhead and return null
    const jobC = await queue.dequeue("worker-C");
    expect(jobC).toBeNull();

    // Clean up
    await queue.ack(jobA.id);
    await queue.ack(jobB.id);
    await pool.query("DELETE FROM job_queue WHERE workflow_id = $1", [taskC.id]);
  });
});
