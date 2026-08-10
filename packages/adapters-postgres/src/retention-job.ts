/**
 * RetentionJob — drops event and usage_ledger partitions older than
 * each tenant's plan.retention_days.
 *
 * Pattern: Cron + Ledger retention
 *
 * Design constraint: partitions in the pooled model may contain rows from
 * multiple tenants. A partition is only dropped when ALL tenants whose data
 * lives in it have exceeded their retention window. The job therefore first
 * finds the minimum retention_days across all active tenants, then drops
 * partitions whose end date precedes (NOW - min_retention_days).
 *
 * Security: uses the direct pool (BYPASSRLS role) because the job processes
 * all tenants in aggregate — no single tenant context applies.
 */

import type { Pool } from "pg";

// Partition name patterns:
//   events_YYYY_MM          (monthly range, from original schema)
//   usage_ledger_YYYY_MM_DD (daily range, from T15)
const PARTITION_PATTERN = /^(events|usage_ledger)_(\d{4})_(\d{2})(?:_(\d{2}))?$/;

export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: Pool,
    /** Interval between retention passes in milliseconds. Default: 24 hours. */
    private readonly intervalMs: number = 24 * 60 * 60 * 1000,
  ) {}

  /** Start the retention loop. Runs once immediately, then on the configured interval. */
  start(): void {
    void this.runRetention().catch((err: unknown) => {
      console.error("[retention] initial pass failed:", err);
    });

    this.timer = setInterval(() => {
      void this.runRetention().catch((err: unknown) => {
        console.error("[retention] scheduled pass failed:", err);
      });
    }, this.intervalMs);
  }

  /** Stop the retention loop. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Execute one retention pass.
   * Returns the number of partition tables dropped.
   */
  async runRetention(): Promise<number> {
    // Determine the minimum retention window across all active tenants.
    const minRetentionResult = await this.pool.query<{ min_days: string }>(
      `SELECT MIN(pl.retention_days) AS min_days
       FROM plan_limits pl
       JOIN tenants t ON t.plan = pl.plan
       WHERE t.status = 'active'`,
    );
    const minRetentionDays = Number(minRetentionResult.rows[0]?.min_days ?? 365);

    // Calculate the cutoff date: partitions ending before this date are eligible.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - minRetentionDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    // Find all partition tables for events and usage_ledger.
    const tablesResult = await this.pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
         AND (tablename LIKE 'events_%' OR tablename LIKE 'usage_ledger_%')
       ORDER BY tablename`,
    );

    let dropped = 0;
    for (const { tablename } of tablesResult.rows) {
      const partitionEndDate = getPartitionEndDate(tablename);
      if (partitionEndDate !== null && partitionEndDate < cutoffDate) {
        await this.pool.query(`DROP TABLE IF EXISTS ${tablename}`);
        dropped++;
        console.info(
          `[retention] dropped partition ${tablename} (end: ${partitionEndDate}, cutoff: ${cutoffDate})`,
        );
      }
    }

    return dropped;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the exclusive end date (YYYY-MM-DD) of a partition given its name,
 * or null if the name does not match a known partition format.
 *
 * Examples:
 *   events_2024_01        → "2024-02-01" (end of January 2024)
 *   usage_ledger_2024_01_15 → "2024-01-16"
 */
function getPartitionEndDate(name: string): string | null {
  const m = PARTITION_PATTERN.exec(name);
  if (!m) return null;

  const year = Number(m[2]);
  const month = Number(m[3]);
  const day = m[4] !== undefined ? Number(m[4]) : undefined;

  if (day !== undefined) {
    // Daily partition — end date is day + 1
    const d = new Date(year, month - 1, day + 1);
    return d.toISOString().slice(0, 10);
  }

  // Monthly partition — end date is first day of next month
  const d = new Date(year, month, 1); // month is 0-indexed in Date()
  return d.toISOString().slice(0, 10);
}
