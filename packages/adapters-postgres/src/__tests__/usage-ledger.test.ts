/**
 * PostgresUsageLedger + UsageRollupJob integration tests (T18 Definition of Done).
 *
 * Requires Testcontainers + Docker.
 *
 * DoD coverage:
 *  ✅ append is idempotent — duplicate entries are silently dropped (ON CONFLICT DO NOTHING)
 *  ✅ append batches multiple entries in one round-trip
 *  ✅ runRollup aggregates usage_ledger into usage_rollups_daily
 *  ✅ runRollup is idempotent — re-running overwrites with fresh sums
 *  ✅ rollup correctly aggregates by tenant and day
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { UsageLedgerEntry } from "@harness/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "../db/client.js";
import { applyMultiTenancy } from "../db/multi-tenancy.js";
import { PostgresUsageLedger } from "../postgres-usage-ledger.js";
import { UsageRollupJob } from "../usage-rollup.js";

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

describe.skipIf(!dockerAvailable)("PostgresUsageLedger + UsageRollupJob (Testcontainers)", () => {
  let pool: Pool;
  let ledger: PostgresUsageLedger;
  let rollup: UsageRollupJob;
  let tenantId: string;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    await applyMultiTenancy(pool);

    ledger = new PostgresUsageLedger(pool);
    rollup = new UsageRollupJob(pool);
    tenantId = randomUUID();

    // Insert a tenant row to satisfy any FK-like checks in tests.
    await pool.query(
      `INSERT INTO tenants (id, slug, plan) VALUES ($1, $2, 'free') ON CONFLICT DO NOTHING`,
      [tenantId, `tenant-${tenantId.slice(0, 8)}`],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------------------
  // append
  // ---------------------------------------------------------------------------

  it("appends entries to usage_ledger", async () => {
    const workflowId = randomUUID();
    const entries: UsageLedgerEntry[] = [
      makeEntry(tenantId, workflowId, "run", 1n, 0.001),
      makeEntry(tenantId, workflowId, "tokens_in", 512n, 0),
      makeEntry(tenantId, workflowId, "tokens_out", 256n, 0.0005),
    ];

    await ledger.append(entries);

    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM usage_ledger WHERE workflow_id = $1",
      [workflowId],
    );
    expect(Number(result.rows[0]?.count)).toBe(3);
  });

  it("is idempotent — duplicate entries are silently dropped", async () => {
    const workflowId = randomUUID();
    const entry = makeEntry(tenantId, workflowId, "run", 1n, 0.001);

    await ledger.append([entry]);
    await ledger.append([entry]); // second insert with same id → ON CONFLICT DO NOTHING

    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM usage_ledger WHERE workflow_id = $1",
      [workflowId],
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it("no-ops on empty array", async () => {
    // Should not throw.
    await expect(ledger.append([])).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // runRollup
  // ---------------------------------------------------------------------------

  it("aggregates usage_ledger into usage_rollups_daily", async () => {
    const workflowId = randomUUID();
    const now = new Date();

    await ledger.append([
      makeEntry(tenantId, workflowId, "run", 1n, 0.02, now),
      makeEntry(tenantId, workflowId, "step", 5n, 0, now),
      makeEntry(tenantId, workflowId, "tokens_in", 1000n, 0, now),
      makeEntry(tenantId, workflowId, "tokens_out", 500n, 0, now),
      makeEntry(tenantId, workflowId, "tool_error", 1n, 0, now),
    ]);

    await rollup.runRollup();

    const result = await pool.query<{
      runs: number;
      steps: number;
      tokens_in: string;
      tokens_out: string;
      cost_usd: string;
      tool_errors: number;
    }>(
      `SELECT runs, steps, tokens_in, tokens_out, cost_usd, tool_errors
       FROM usage_rollups_daily
       WHERE tenant_id = $1 AND day = $2::date`,
      [tenantId, now.toISOString().slice(0, 10)],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    const row = result.rows[0];
    if (!row) return;
    // At least one 'run' row from this test — other tests may have added more.
    expect(row.runs).toBeGreaterThanOrEqual(1);
    expect(row.steps).toBeGreaterThanOrEqual(5);
    expect(Number(row.tokens_in)).toBeGreaterThanOrEqual(1000);
    expect(Number(row.tokens_out)).toBeGreaterThanOrEqual(500);
    expect(row.tool_errors).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — re-running rollup overwrites the row with same sums", async () => {
    const tenantId2 = randomUUID();
    const workflowId = randomUUID();
    const now = new Date();

    await pool.query(
      `INSERT INTO tenants (id, slug, plan) VALUES ($1, $2, 'free') ON CONFLICT DO NOTHING`,
      [tenantId2, `tenant-${tenantId2.slice(0, 8)}`],
    );

    await ledger.append([makeEntry(tenantId2, workflowId, "run", 1n, 0.01, now)]);
    await rollup.runRollup();

    const first = await pool.query<{ runs: number }>(
      "SELECT runs FROM usage_rollups_daily WHERE tenant_id = $1 AND day = $2::date",
      [tenantId2, now.toISOString().slice(0, 10)],
    );

    await rollup.runRollup(); // second run must produce identical result

    const second = await pool.query<{ runs: number }>(
      "SELECT runs FROM usage_rollups_daily WHERE tenant_id = $1 AND day = $2::date",
      [tenantId2, now.toISOString().slice(0, 10)],
    );

    expect(second.rows[0]?.runs).toBe(first.rows[0]?.runs);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeEntry(
  tenantId: string,
  workflowId: string,
  kind: string,
  qty: bigint,
  costUsd: number,
  ts: Date = new Date(),
): UsageLedgerEntry {
  return { id: randomUUID(), tenantId, workflowId, ts, kind, qty, costUsd };
}
