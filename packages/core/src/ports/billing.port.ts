/**
 * BillingPort — reproducible invoice and plan-limit enforcement.
 *
 * Pattern: Port (Hexagonal Architecture)
 *
 * The concrete Postgres implementation reads from usage_rollups_daily (CQRS
 * read model). A future StripeBillingAdapter can wrap this port to push metered
 * events to Stripe without touching domain code.
 *
 * Security: all queries must be executed inside withTenantCtx so RLS applies.
 */

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export interface MonthlyInvoice {
  tenantId: string;
  /** Calendar month: YYYY-MM */
  month: string;
  plan: string;
  runs: number;
  steps: number;
  tokensIn: bigint;
  tokensOut: bigint;
  costUsd: number;
  toolErrors: number;
}

// ---------------------------------------------------------------------------
// Plan violation — returned as a value, never thrown
// ---------------------------------------------------------------------------

export type PlanViolationKind = "monthly_runs" | "concurrency" | "suspended" | "deleting";

export interface PlanViolation {
  kind: PlanViolationKind;
  limit: number;
  current: number;
  /** ISO-8601 date after which the client may retry (for monthly_runs: first day of next month). */
  retryAfter?: string;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface BillingPort {
  /**
   * Returns the aggregated monthly invoice from usage_rollups_daily.
   * `month` format: YYYY-MM. Reproducible for any past month.
   */
  getMonthlyInvoice(tenantId: string, month: string): Promise<MonthlyInvoice>;

  /**
   * Cross-checks the rollup totals against the raw usage_ledger for a given
   * month. Returns the difference; callers treat non-zero as a discrepancy.
   * Used in audit / dispute resolution — not in the hot path.
   */
  verifyInvoiceWithLedger(
    tenantId: string,
    month: string,
  ): Promise<{ costDeltaUsd: number; runsDelta: number }>;

  /**
   * Returns the total number of `run` entries in usage_rollups_daily for the
   * current calendar month. Used by PlanEnforcer before starting a workflow.
   */
  getMonthlyRunCount(tenantId: string): Promise<number>;

  /**
   * Checks whether the tenant is within plan limits.
   * Returns null if allowed, or a PlanViolation describing the breach.
   */
  checkPlanLimits(tenantId: string): Promise<PlanViolation | null>;
}

// ---------------------------------------------------------------------------
// NoopBillingAdapter — zero totals, no violations; for tests and dev
// ---------------------------------------------------------------------------

export class NoopBillingAdapter implements BillingPort {
  async getMonthlyInvoice(tenantId: string, month: string): Promise<MonthlyInvoice> {
    return {
      tenantId,
      month,
      plan: "unlimited",
      runs: 0,
      steps: 0,
      tokensIn: 0n,
      tokensOut: 0n,
      costUsd: 0,
      toolErrors: 0,
    };
  }

  async verifyInvoiceWithLedger(
    _tenantId: string,
    _month: string,
  ): Promise<{ costDeltaUsd: number; runsDelta: number }> {
    return { costDeltaUsd: 0, runsDelta: 0 };
  }

  async getMonthlyRunCount(_tenantId: string): Promise<number> {
    return 0;
  }

  async checkPlanLimits(_tenantId: string): Promise<PlanViolation | null> {
    return null;
  }
}
