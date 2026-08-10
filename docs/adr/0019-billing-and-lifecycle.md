# ADR 0019 — Billing and tenant lifecycle

## Status
Accepted

## Context

T19 closes the SaaS loop: every tenant run must appear on a reproducible invoice,
plan limits must be enforced before new work starts, and offboarding must leave
no orphaned data in any system.

The existing data model already has `usage_ledger` (append-only fact table) and
`usage_rollups_daily` (CQRS read model from T18). Billing must read from rollups,
not from the raw ledger — the ledger exists for auditing and dispute resolution,
not for low-latency dashboard queries.

## Decision

### 1. BillingPort in `packages/core`

A `BillingPort` interface lets domain code depend on billing concepts without
importing Postgres or Stripe. Two implementations:

- `PostgresBillingAdapter` — queries `usage_rollups_daily` for invoice data and
  `usage_ledger` for auditable raw totals.
- `NoopBillingAdapter` — returns zero totals; used in tests and single-tenant dev.

Stripe integration is intentionally **not** part of this task. The port design
allows a `StripeBillingAdapter` to be added as a thin adapter without touching
the domain. Stripe's metered billing API receives events derived from rollups —
the ledger remains the source of truth.

### 2. Invoice calculation from `usage_rollups_daily`

`PostgresBillingAdapter.getMonthlyInvoice(tenantId, 'YYYY-MM')` aggregates the
`usage_rollups_daily` rows for the given month. This is reproducible: running it
at any future point in time for a past month produces the same result because
rollups are idempotent upserts from the append-only ledger.

A `verifyInvoiceWithLedger()` method provides penny-accurate cross-check against
the raw ledger — used in tests and audits, not in the hot path.

### 3. PlanEnforcer

Checks `plan_limits.monthly_runs` against the current-month rollup before
allowing a new workflow to start. Returns a typed `PlanViolation` (not an
exception) so the caller can decide how to respond — typically `429 Too Many
Requests` with a `Retry-After` header set to the start of the next calendar month.

When the limit is exceeded, the tenant's `status` in the `tenants` table is set
to `limit_exceeded`. The UI and API can use this for a read-only mode banner.
Existing running workflows are never interrupted.

### 4. RetentionJob

Drops `events` and `usage_ledger` daily partitions older than
`plan_limits.retention_days` for each tenant. Uses `DROP TABLE` on the individual
partition, never `DELETE FROM`. Runs as a cron-style job (same pattern as
`UsageRollupJob`).

Design constraint: only partitions where **all** tenants have exceeded their
retention window are dropped. In the pooled model, a single partition may hold
rows from multiple tenants — the job therefore checks the earliest `ts` per
tenant before deciding. If any tenant in the partition is still within their
window, the partition is skipped.

### 5. DeletionService

Handles GDPR Art. 17 "right to erasure" for a whole tenant. Steps (executed in
order, each idempotent):

1. Set `tenants.status = 'deleting'` — prevents new workflows from starting.
2. Wait for all in-flight workflows to finish or exceed their max lease timeout.
3. Delete from all tenant-scoped Postgres tables in reverse FK order.
4. Stub calls to `BlobStorePort.deleteAllForTenant()` and `KmsPort.deleteKey()`.
5. Set `tenants.status = 'deleted'` (or hard-delete the row after confirmation).

The confirmation step (5) is exposed via `POST /tenants/:id/lifecycle` with
`{ action: "confirm-deletion" }`. This follows the same delayed-deletion
pattern as GitHub's repo deletion.

### 6. GDPR export

`GET /tenants/:id/export` returns a JSON document containing all tenant data from
all tables. Requires `admin` role. Implemented as a streaming response to avoid
holding the full dataset in memory. Target latency: < 30 s for a typical tenant;
< 24 h is the contractual SLA.

### 7. Routes

```
GET  /billing/invoice/:month     — monthly invoice (YYYY-MM)
GET  /billing/usage              — current month running total
GET  /tenants/:id/export         — GDPR data export (JSON)
POST /tenants/:id/lifecycle      — lifecycle transitions: suspend/reactivate/request-deletion/confirm-deletion
```

## Consequences

- Invoice reproducibility: `verifyInvoiceWithLedger()` proves the rollup matches
  the raw ledger to the cent. This is the main customer-facing dispute resolution
  tool.
- Retention safety: partition drops are safe because the decision is tenant-aware
  and the ledger is append-only (no risk of re-inserting deleted data).
- No Stripe in this task: the `BillingPort` is intentionally minimal. Stripe
  integration adds webhook handling, subscription state, and retry logic that is
  a separate concern and a separate PR.

## Rejected alternatives

- **Reading directly from `usage_ledger` for invoices**: too slow at scale and
  the ledger is partitioned by day — a monthly invoice requires scanning up to
  31 partitions.
- **Deleting individual rows for GDPR erasure**: `DROP PARTITION` is O(1) and
  leaves no orphans. Row-level deletion on an append-only log is O(n) and
  requires a full table rewrite.
- **Stripe as a hard dependency**: Stripe is not available in tests or local dev;
  the port keeps the domain testable without mocking an external SDK.
