/**
 * StripeBillingAdapter — BillingPort stub backed by Stripe.
 *
 * Pattern: Adapter (Anti-Corruption Layer)
 *
 * This is a skeleton implementation. Each method reads usage from the local
 * Postgres billing adapter (source of truth) and will, in a future iteration,
 * reconcile or push usage records to Stripe Billing / Metered Billing API.
 *
 * Tracked in: T20 (Stripe integration)
 *
 * Until T20 ships, all methods delegate to PostgresBillingAdapter so the
 * BillingPort contract is fulfilled without Stripe credentials.
 */

import type { BillingPort, MonthlyInvoice, PlanViolation } from "@harness/core";
import type { Pool } from "pg";
import { PostgresBillingAdapter } from "./postgres-billing.js";

// ---------------------------------------------------------------------------
// Stripe client type stub — replaced by `stripe` npm package at T20
// ---------------------------------------------------------------------------

export interface StripeConfig {
  /** Stripe secret key (sk_live_* or sk_test_*). */
  secretKey: string;
  /** Optional Stripe webhook signing secret for event verification. */
  webhookSecret?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class StripeBillingAdapter implements BillingPort {
  private readonly postgres: PostgresBillingAdapter;

  constructor(
    pool: Pool,
    /** Stripe config — unused until T20; accepted here so the wiring is ready. */
    _stripeConfig: StripeConfig,
  ) {
    this.postgres = new PostgresBillingAdapter(pool);
  }

  async getMonthlyInvoice(tenantId: string, month: string): Promise<MonthlyInvoice> {
    // TODO(T20): push finalized invoices to Stripe Invoice API.
    return this.postgres.getMonthlyInvoice(tenantId, month);
  }

  async verifyInvoiceWithLedger(
    tenantId: string,
    month: string,
  ): Promise<{ costDeltaUsd: number; runsDelta: number }> {
    // TODO(T20): cross-check Stripe invoice line items against local ledger.
    return this.postgres.verifyInvoiceWithLedger(tenantId, month);
  }

  async getMonthlyRunCount(tenantId: string): Promise<number> {
    // TODO(T20): report metered usage to Stripe Billing Meter API.
    return this.postgres.getMonthlyRunCount(tenantId);
  }

  async checkPlanLimits(tenantId: string): Promise<PlanViolation | null> {
    // TODO(T20): honour Stripe subscription status (e.g. past_due → suspended).
    return this.postgres.checkPlanLimits(tenantId);
  }
}
