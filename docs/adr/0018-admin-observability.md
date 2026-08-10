# ADR 0018 — Admin Observability: Metrics, Logs, Traces

## Context

After T17 (queue + workers), multiple worker processes run in parallel. We need:

1. **Health signals** — is the queue draining? Are workers alive? Is any tenant's cost exploding?
2. **Debugging** — correlate a failed workflow with its trace and log lines.
3. **Cost accounting** — per-tenant daily usage rollups that billing (T19) can read without
   touching the hot OLTP tables.
4. **Tenant self-service** — users must see their own usage via API, never gain access to Grafana.

## Decision

### Telemetry routing: OTel Collector as the hub

All three signals (traces, metrics, logs) leave the application as OTLP over HTTP to the
collector. The collector routes them to the appropriate backends:

- **Traces** → Tempo (replacing Jaeger; Tempo integrates natively with Grafana and supports
  correlation with Loki via TraceQL)
- **Metrics** → Prometheus (collector exposes a Prometheus scrape endpoint on port 9464)
- **Logs** → Loki (collector's `loki` exporter, tenant_id as Loki stream label)

The app only speaks OTLP. No backend SDK is imported into application code.

### Trace sampling strategy: tail sampling in the collector

The collector uses the `tail_sampling` processor:
- 100 % of error spans (status = ERROR)
- 5 % of success spans (probabilistic)

This is tail sampling — the decision is made after the full trace arrives, so error traces are
never dropped mid-flight. The app emits all spans; the collector decides what to store.

### Prometheus cardinality rule: plan/model/tool_type — never tenant_id

Prometheus is a time-series database. A label that takes N distinct values creates N series.
With hundreds of tenants, `tenant_id` as a label would create O(tenants × metrics) series and
eventually cause memory exhaustion.

Rule: Prometheus answers "is the system healthy?". The event log / Loki answers "what did
tenant X do?" The two concerns are never mixed.

Low-cardinality labels allowed in Prometheus: `plan`, `region`, `tool_name`, `model`,
`workflow_status`, `error_code`.

High-cardinality data (tenant_id, workflow_id) lives in:
- Loki (log stream label `tenant_id`)
- Tempo span attribute `harness.workflow_id`
- `usage_ledger` / `usage_rollups_daily` in Postgres

### CQRS for cost rollups: usage_ledger → usage_rollups_daily

`usage_ledger` is the append-only source of truth (Ledger pattern). Every workflow completion
writes one or more rows: `kind ∈ {run, step, tokens_in, tokens_out, tool_error}`.

`usage_rollups_daily` is the read model. A scheduled rollup job (`UsageRollupJob`) aggregates
yesterday's ledger rows into daily summaries using an upsert:

```sql
INSERT INTO usage_rollups_daily (tenant_id, day, runs, steps, tokens_in, tokens_out, cost_usd, tool_errors)
SELECT tenant_id, ts::date, ...
FROM usage_ledger
WHERE ts >= $1 AND ts < $2
GROUP BY tenant_id, ts::date
ON CONFLICT (tenant_id, day) DO UPDATE SET ...
```

This means the billing service (T19) reads from a pre-aggregated table, not from the hot
partitioned `usage_ledger` that workers write to.

### Tenant observability API

`GET /observability/usage` returns daily rollups for the authenticated tenant.
`GET /observability/events` returns the workflow event stream for a specific workflow.

Both routes enforce RLS: `withTenantCtx` sets `app.tenant_id`, so the query cannot see other
tenants' rows even if the SQL is wrong.

### Log redaction

No prompt content, no secret values, no PII in logs. The existing `SecretRedactor` from T16 is
reused. Log statements use identifiers (workflow_id, tenant_id, tool_name), never content.

## Consequences

- Loki, Tempo, Prometheus, and Grafana are added to `docker-compose.yml`. Local dev now
  requires more RAM (~2 GB extra). This is acceptable for a developer workstation; in CI the
  observability stack is not started (tests use the in-memory adapters).
- Jaeger is removed. Tempo covers the same use case with better Grafana integration.
- The `UsageLedgerPort` is a new port in `packages/core`. HarnessRuntime does not call it
  directly — the server's `HarnessService` writes to the ledger after each `start()` completes.
  This keeps the runtime free of I/O concerns.
- The rollup job runs in the worker process (alongside the WorkerLoop) on a configurable
  interval (default: every 1 hour). This avoids a separate cron container.

## Rejected alternatives

| Alternative | Reason rejected |
|---|---|
| Prometheus remote_write from app | Adds a Prometheus SDK dependency to the app; OTLP is already wired |
| ClickHouse for usage data | Overkill for current scale; Postgres + partitions + rollups is sufficient |
| OpenSearch/ElasticSearch for logs | Loki is lighter, integrates natively with Grafana, no JVM |
| Keep Jaeger | Tempo adds exemplar support (link from Prometheus metric → trace); Jaeger doesn't |
| Pull-based log shipping (Promtail) | Requires file-based logging; structured OTLP logs are richer and already on the wire |
