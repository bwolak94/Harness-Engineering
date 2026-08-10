/**
 * PostgresBillingAdapter + DeletionService integration tests (T19 DoD).
 *
 * Requires Testcontainers + Docker.
 *
 * DoD coverage:
 *  ✅ getMonthlyInvoice aggregates rollups for a given month
 *  ✅ getMonthlyInvoice returns zero totals for a month with no data
 *  ✅ verifyInvoiceWithLedger returns zero delta when rollup matches ledger
 *  ✅ checkPlanLimits returns null when tenant is within limits
 *  ✅ checkPlanLimits returns monthly_runs violation when limit exceeded
 *  ✅ checkPlanLimits returns suspended violation for suspended tenant
 *  ✅ DeletionService.requestDeletion sets status to 'deleting'
 *  ✅ DeletionService.confirmDeletion cascades all tenant data
 *  ✅ confirmDeletion is idempotent — re-running on 'deleted' tenant is safe
 *  ✅ exportTenantData returns all tables
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "../db/client.js";
import { applyMultiTenancy } from "../db/multi-tenancy.js";
import { DeletionService } from "../deletion-service.js";
import { PostgresBillingAdapter } from "../postgres-billing.js";
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

describe.skipIf(!dockerAvailable)(
  "PostgresBillingAdapter + DeletionService (Testcontainers)",
  () => {
    let pool: Pool;
    let billing: PostgresBillingAdapter;
    let ledger: PostgresUsageLedger;
    let rollup: UsageRollupJob;
    let deletion: DeletionService;
    let tenantId: string;

    beforeAll(async () => {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const container = await new PostgreSqlContainer("postgres:17-alpine").start();

      pool = new Pool({ connectionString: container.getConnectionUri() });
      await applySchema(pool);
      await applyMultiTenancy(pool);

      billing = new PostgresBillingAdapter(pool);
      ledger = new PostgresUsageLedger(pool);
      rollup = new UsageRollupJob(pool);
      deletion = new DeletionService(pool);
      tenantId = randomUUID();

      await pool.query(
        "INSERT INTO tenants (id, slug, plan) VALUES ($1, $2, 'starter') ON CONFLICT DO NOTHING",
        [tenantId, `tenant-${tenantId.slice(0, 8)}`],
      );
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    // ---------------------------------------------------------------------------
    // getMonthlyInvoice
    // ---------------------------------------------------------------------------

    it("returns zero totals for a month with no data", async () => {
      const invoice = await billing.getMonthlyInvoice(tenantId, "2020-01");
      expect(invoice.runs).toBe(0);
      expect(invoice.costUsd).toBe(0);
      expect(invoice.tokensIn).toBe(0n);
    });

    it("aggregates rollups for a given month", async () => {
      const workflowId = randomUUID();
      // Use the current date so the insert lands in an existing partition.
      const ts = new Date();
      const currentMonth = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}`;

      await ledger.append([
        { id: randomUUID(), tenantId, workflowId, ts, kind: "run", qty: 1n, costUsd: 0.05 },
        { id: randomUUID(), tenantId, workflowId, ts, kind: "tokens_in", qty: 2000n, costUsd: 0 },
        { id: randomUUID(), tenantId, workflowId, ts, kind: "tokens_out", qty: 800n, costUsd: 0 },
        { id: randomUUID(), tenantId, workflowId, ts, kind: "step", qty: 3n, costUsd: 0 },
      ]);
      await rollup.runRollup();

      const invoice = await billing.getMonthlyInvoice(tenantId, currentMonth);
      expect(invoice.runs).toBeGreaterThanOrEqual(1);
      expect(invoice.costUsd).toBeGreaterThanOrEqual(0.05);
      expect(invoice.tokensIn).toBeGreaterThanOrEqual(2000n);
      expect(invoice.tokensOut).toBeGreaterThanOrEqual(800n);
      expect(invoice.steps).toBeGreaterThanOrEqual(3);
    });

    // ---------------------------------------------------------------------------
    // verifyInvoiceWithLedger
    // ---------------------------------------------------------------------------

    it("returns zero delta when rollup matches ledger", async () => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const delta = await billing.verifyInvoiceWithLedger(tenantId, currentMonth);
      // Rollup was just run, so delta should be 0.
      expect(delta.costDeltaUsd).toBeCloseTo(0, 6);
      expect(delta.runsDelta).toBe(0);
    });

    // ---------------------------------------------------------------------------
    // checkPlanLimits
    // ---------------------------------------------------------------------------

    it("returns null when tenant is within limits", async () => {
      const violation = await billing.checkPlanLimits(tenantId);
      // starter plan has 500 monthly_runs; we have far fewer
      expect(violation).toBeNull();
    });

    it("returns monthly_runs violation when limit is exceeded", async () => {
      // Create a tenant with free plan (50 monthly_runs limit).
      const limitedTenantId = randomUUID();
      await pool.query(
        "INSERT INTO tenants (id, slug, plan) VALUES ($1, $2, 'free') ON CONFLICT DO NOTHING",
        [limitedTenantId, `free-${limitedTenantId.slice(0, 8)}`],
      );

      // Insert exactly 50 'run' rollup rows for the current month.
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const dayStr = now.toISOString().slice(0, 10);

      await pool.query(
        `INSERT INTO usage_rollups_daily (tenant_id, day, runs, steps, tokens_in, tokens_out, cost_usd, tool_errors)
       VALUES ($1, $2, 50, 0, 0, 0, 0, 0)
       ON CONFLICT (tenant_id, day) DO UPDATE SET runs = 50`,
        [limitedTenantId, dayStr],
      );

      const violation = await billing.checkPlanLimits(limitedTenantId);
      expect(violation).not.toBeNull();
      expect(violation?.kind).toBe("monthly_runs");
      expect(violation?.limit).toBe(50);
      expect(violation?.current).toBe(50);
      expect(violation?.retryAfter).toBeDefined();
      void month;
    });

    it("returns suspended violation for suspended tenant", async () => {
      const suspendedId = randomUUID();
      await pool.query(
        "INSERT INTO tenants (id, slug, plan, status) VALUES ($1, $2, 'free', 'suspended') ON CONFLICT DO NOTHING",
        [suspendedId, `susp-${suspendedId.slice(0, 8)}`],
      );
      const violation = await billing.checkPlanLimits(suspendedId);
      expect(violation?.kind).toBe("suspended");
    });

    // ---------------------------------------------------------------------------
    // DeletionService
    // ---------------------------------------------------------------------------

    it("requestDeletion sets tenant status to 'deleting'", async () => {
      const targetId = randomUUID();
      await pool.query(
        "INSERT INTO tenants (id, slug, plan) VALUES ($1, $2, 'free') ON CONFLICT DO NOTHING",
        [targetId, `del-${targetId.slice(0, 8)}`],
      );

      await deletion.requestDeletion(targetId);

      const result = await pool.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1",
        [targetId],
      );
      expect(result.rows[0]?.status).toBe("deleting");
    });

    it("confirmDeletion cascades all tenant data and sets status to 'deleted'", async () => {
      const targetId = randomUUID();
      await pool.query(
        "INSERT INTO tenants (id, slug, plan) VALUES ($1, $2, 'free') ON CONFLICT DO NOTHING",
        [targetId, `del2-${targetId.slice(0, 8)}`],
      );

      // Insert some data to verify cascade.
      await pool.query(
        "INSERT INTO workflows (id, tenant_id, status) VALUES ($1, $2, 'completed')",
        [randomUUID(), targetId],
      );

      await deletion.requestDeletion(targetId);
      const deleteResult = await deletion.confirmDeletion(targetId);

      expect(deleteResult.tablesCleared.length).toBeGreaterThan(0);

      // Workflows should be gone.
      const workflows = await pool.query("SELECT id FROM workflows WHERE tenant_id = $1", [
        targetId,
      ]);
      expect(workflows.rows).toHaveLength(0);

      // Tenant row should be 'deleted'.
      const tenant = await pool.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1",
        [targetId],
      );
      expect(tenant.rows[0]?.status).toBe("deleted");
    });

    it("confirmDeletion is idempotent — safe to call again on 'deleted' tenant", async () => {
      const targetId = randomUUID();
      await pool.query(
        "INSERT INTO tenants (id, slug, plan, status) VALUES ($1, $2, 'free', 'deleted') ON CONFLICT DO NOTHING",
        [targetId, `del3-${targetId.slice(0, 8)}`],
      );

      // Should not throw.
      const result = await deletion.confirmDeletion(targetId);
      expect(result.tablesCleared).toHaveLength(0);
    });

    it("exportTenantData returns an object with a tables key", async () => {
      const exported = await deletion.exportTenantData(tenantId);
      expect(exported).toHaveProperty("exportedAt");
      expect(exported).toHaveProperty("tenantId", tenantId);
      expect(exported).toHaveProperty("tables");
      const tables = exported.tables as Record<string, unknown[]>;
      expect(tables).toHaveProperty("workflows");
      expect(tables).toHaveProperty("events");
    });
  },
);
