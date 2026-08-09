# ADR-0015 — Multi-tenancy and Access Model

## Context

T00–T14 implement a single-tenant runtime. Moving to a SaaS platform (Part II) requires
multiple tenants to share the same Postgres instance without their data ever mixing.
The primary failure mode is not malicious access but silent bugs: a missing `WHERE tenant_id`
clause, a forgotten JOIN, a cache entry belonging to a different tenant. RLS enforced at the
database level catches all three even when application code is buggy.

## Decision

### 1. Row-Level Security as the isolation primitive

Every table (control plane and data plane) carries a `tenant_id TEXT NOT NULL` column.
RLS is enabled on all tables. The policy expression is:

```sql
USING (tenant_id = current_setting('app.tenant_id', true))
```

`current_setting('app.tenant_id', true)` returns `''` when the setting is absent, which
satisfies no row — so a connection that forgets `SET LOCAL` sees nothing rather than everything.

### 2. Two database roles

- `app_rw` — the application role. Has `SELECT/INSERT/UPDATE/DELETE` on all tables.
  Does NOT have `BYPASSRLS`. All runtime connections use this role.
- `app_migrator` — the migration role. Has `BYPASSRLS` and schema DDL rights.
  Used only by the migration runner (`drizzle-kit` or `applySchema()`).

Superusers (Testcontainers) always bypass RLS; isolation tests use `SET LOCAL ROLE app_rw`
inside a transaction to drop to the limited role.

### 3. Tenant context via `SET LOCAL`

Every database operation is wrapped in a transaction that begins with:

```sql
SET LOCAL app.tenant_id = '<tenantId>';
SET LOCAL ROLE app_rw;
```

The helper `withTenantCtx(pool, tenantId, fn)` handles this contract. No direct pool usage
is allowed from tenant-scoped code paths.

### 4. Control plane tables

New tables: `tenants`, `users`, `memberships`, `platform_api_keys`,
`tool_definitions`, `tool_versions`, `agents`, `policies`, `plan_limits`, `mcp_servers`.

`tool_versions` is append-only (a `BEFORE UPDATE OR DELETE` trigger rejects all mutations).
Tool definitions are versioned so workflows can resume days later on the exact version they started.

### 5. Data plane additions

Existing `workflows`, `events`, `snapshots` tables gain a `tenant_id` column (DEFAULT `'system'`
for existing single-tenant rows). New tables: `usage_ledger` (partitioned daily), `approvals`,
`job_queue`, `step_leases` (T17), `outbox` with `tenant_id`.

`usage_ledger` is range-partitioned by `ts` (one partition per day). Partitions for the
current and next month are created by `create_usage_partitions(year, month)` called from
migrations and a scheduled job.

### 6. JWT-based tenant context extraction

Requests carry `Authorization: Bearer <HS256-JWT>`. The token payload must include:
- `tenantId: string`
- `userId: string`
- `role: "owner" | "admin" | "member" | "viewer"`

The server verifies the signature with `JWT_SECRET` (from env) using Node.js native
`node:crypto` — no external library. The extracted `TenantContext` is attached to the
Fastify request and passed into `withTenantCtx`.

### 7. Plan limits enforcement

At workflow start, `HarnessService` checks `plan_limits` for the tenant's plan and compares
against active workflow count. Workflows exceeding `max_concurrency` are enqueued (T17) rather
than rejected — this satisfies DoD #4.

## Rejected alternatives

- **Separate schema per tenant** — doesn't scale (migration cost × N tenants, etcd limits in K8s).
- **Application-layer filtering only** — a single forgotten `WHERE` clause causes a data leak.
  Database-level RLS is mandatory, not optional.
- **Namespace per tenant in K8s** — not a data isolation mechanism; leaks through shared Postgres.
- **External JWT library (jsonwebtoken, jose)** — `node:crypto` covers HS256 without an extra dep.
  Asymmetric verification (RS256/ES256 for JWKS) is T16 work when real OIDC providers are wired.

## Consequences

- Every query must go through `withTenantCtx`. Raw pool queries in tests work only for
  schema setup (superuser bypasses RLS).
- Adding a new table without RLS breaks the tenant-isolation test suite (test generates from
  the table list — new table without policy → CI fails).
- `tool_versions` is immutable at the DB level; updates must create a new version row.
- The partition function must be called ahead of time (cron job). Missing partition = insert error.
