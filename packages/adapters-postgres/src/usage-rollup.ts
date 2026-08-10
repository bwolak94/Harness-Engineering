/**
 * UsageRollupJob — aggregates usage_ledger into usage_rollups_daily.
 *
 * Pattern: CQRS (read model update) + Ledger
 *
 * Runs on a configurable interval (default: every hour). Each run:
 *  1. Computes the target date window (yesterday + today so partial days are refreshed).
 *  2. Upserts aggregated rows into usage_rollups_daily.
 *
 * The upsert is idempotent — running multiple times for the same day overwrites
 * the row with fresh sums, which is correct because usage_ledger is append-only
 * and the aggregate can only grow.
 *
 * Security: uses direct pool (bypasses RLS) to aggregate across all tenants.
 * Requires BYPASSRLS role in production.
 */

import type { Pool } from "pg";

export class UsageRollupJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly intervalMs: number = 60 * 60 * 1000, // default: 1 hour
  ) {}

  /** Start the rollup loop. Runs once immediately, then on the configured interval. */
  start(): void {
    // Run once on startup to catch any missed entries from a previous crash.
    void this.runRollup().catch((err: unknown) => {
      console.error("[rollup] initial rollup failed:", err);
    });

    this.timer = setInterval(() => {
      void this.runRollup().catch((err: unknown) => {
        console.error("[rollup] scheduled rollup failed:", err);
      });
    }, this.intervalMs);
  }

  /** Stop the rollup loop. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Aggregate usage_ledger entries into usage_rollups_daily.
   * Covers yesterday and today so partial-day data is always refreshed.
   *
   * Returns the number of tenant-day rows upserted.
   */
  async runRollup(daysBefore = 2): Promise<number> {
    // Window: from daysBefore days ago (midnight) to now.
    const result = await this.pool.query<{ count: string }>(
      `INSERT INTO usage_rollups_daily (tenant_id, day, runs, steps, tokens_in, tokens_out, cost_usd, tool_errors)
       SELECT
         tenant_id,
         ts::date                                               AS day,
         COUNT(*) FILTER (WHERE kind = 'run')                               AS runs,
         COALESCE(SUM(qty) FILTER (WHERE kind = 'step'), 0)::integer       AS steps,
         COALESCE(SUM(qty) FILTER (WHERE kind = 'tokens_in'), 0)           AS tokens_in,
         COALESCE(SUM(qty) FILTER (WHERE kind = 'tokens_out'), 0)          AS tokens_out,
         COALESCE(SUM(cost_usd) FILTER (WHERE kind = 'run'), 0)            AS cost_usd,
         COUNT(*) FILTER (WHERE kind = 'tool_error')                       AS tool_errors
       FROM usage_ledger
       WHERE ts >= NOW() - ($1 * INTERVAL '1 day')
         AND ts <  NOW() + INTERVAL '1 day'
       GROUP BY tenant_id, ts::date
       ON CONFLICT (tenant_id, day) DO UPDATE
         SET runs        = EXCLUDED.runs,
             steps       = EXCLUDED.steps,
             tokens_in   = EXCLUDED.tokens_in,
             tokens_out  = EXCLUDED.tokens_out,
             cost_usd    = EXCLUDED.cost_usd,
             tool_errors = EXCLUDED.tool_errors
       RETURNING (SELECT count(*) FROM usage_rollups_daily)`,
      [daysBefore],
    );

    return Number(result.rows[0]?.count ?? 0);
  }
}
