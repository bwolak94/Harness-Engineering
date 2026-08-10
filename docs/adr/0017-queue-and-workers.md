# ADR 0017 — Queue, Workers and Limits (T17)

## Context

After T16, the harness handles secrets, egress, and declarative tools. The runtime
executes workflows fire-and-forget in-process. This is fine for a single server but
fails at scale:

- **No fair scheduling**: one heavy tenant can starve others.
- **No crash recovery at the process level**: if the server restarts mid-workflow,
  the in-flight execution is lost (T07's resume covers per-step recovery but not
  process-level crashes).
- **No rate limiting**: a buggy client can submit thousands of requests per second.
- **No horizontal scaling**: the queue must be external to allow multiple workers.

T17 introduces a Postgres-backed job queue, per-workflow step leases with heartbeat,
tenant-level concurrency bulkheads, and a token-bucket rate limiter.

## Decision

### Job Queue — Postgres `FOR UPDATE SKIP LOCKED`

`job_queue` already exists in the schema (T15). Workers dequeue by:

```sql
SELECT id, tenant_id, workflow_id, priority, attempts
FROM   job_queue
WHERE  locked_by IS NULL
  AND  run_after <= NOW()
ORDER  BY priority DESC, run_after ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

Within the same transaction, set `locked_by = workerId, locked_until = NOW() + interval`.
After commit, the row is visible to other workers but skipped because `locked_by IS NOT NULL`.

**Why Postgres instead of Redis/RabbitMQ?** The event log is already in Postgres. Keeping
the queue there gives transactional guarantees (enqueue and event-log append in one
transaction if needed) and avoids a second infrastructure dependency. Postgres queues
handle thousands of jobs/minute, which is sufficient for this stage.

### Lease + Heartbeat — `step_leases` table

Each claimed workflow gets a row in `step_leases`:
- `acquire`: `INSERT ON CONFLICT DO NOTHING`; false if already held.
- `heartbeat`: `UPDATE ... RETURNING` — renews `lease_until` while the worker is alive.
- `release`: `DELETE` on graceful shutdown.
- `reapExpired`: `DELETE WHERE lease_until < NOW()` + reset `job_queue.locked_by` for
  orphaned jobs. Runs as DB superuser / `BYPASSRLS` role because the reaper must see
  all tenants' leases.

**Production note**: the worker process must connect with a role that has `BYPASSRLS`
(or is a superuser) to see across all tenants. In tests, Testcontainers uses the
`postgres` superuser, which bypasses `FORCE ROW LEVEL SECURITY`.

### Bulkhead per Tenant

Before claiming a job, the worker checks `plan_limits.max_concurrency` for that
tenant. If the tenant is already at its limit (active locked_by count >= max_concurrency),
the job is returned to the queue with a short delay. This prevents one tenant from
consuming all worker capacity.

### Token Bucket Rate Limiter

Two implementations behind `RateLimiterPort`:

| Implementation | When | Algorithm |
|---|---|---|
| `InMemoryRateLimiter` | Tests, single-process dev | Sliding window counter, per-key `Map<string, number[]>` |
| `RedisRateLimiter` | Production | Atomic Lua script, sliding window via sorted set (`ZADD` + `ZREMRANGEBYSCORE`) |

Rate limit key: `rl:<tenantId>:<method>:<path>` — per tenant and per endpoint.
Default limits are configured in `Env`: `RATE_LIMIT_RPM` (requests per minute).

On rejection: HTTP 429 with `Retry-After` header (seconds until the oldest request
in the window expires).

### Worker Process (`apps/worker`)

Separate Node.js entry point. `WorkerLoop`:
1. Poll queue with `dequeue(workerId)`.
2. Check bulkhead; if over limit → `nack` with 5 s delay.
3. Acquire lease; if fails → `nack` with 0 delay.
4. Start heartbeat interval (`leaseDurationMs / 2`).
5. Execute: `HarnessRuntime.run()` for new workflows; `HarnessRuntime.resume()` for
   restarted workflows (detected by event log having a `workflow.started` event already).
6. On success: `ack` + `release`.
7. On failure: `nack` with exponential backoff (`min(2^attempts * 1s, 60s)` + ±25% jitter);
   after `maxAttempts`, `ack` (give up) and emit `workflow.failed`.
8. SIGTERM: set `AbortSignal`, finish current job, drain, release lease.

### Graceful Shutdown

`SIGTERM` → set `AbortController.abort()` → `WorkerLoop.run()` exits after the current
job finishes → `release()` all held leases → process exits. K8s
`terminationGracePeriodSeconds` must exceed the maximum expected job duration.

### Leader Election

For scheduler/reaper singletons, the recommendation is Kubernetes `Lease` API.
In this implementation, the reaper runs in every worker but uses `FOR UPDATE SKIP LOCKED`
on a synthetic "reaper lock" row to ensure only one reaper fires per tick.
Full K8s Lease API integration is deferred to a production hardening task.

## Consequences

**Positive:**
- Horizontal scaling: add worker replicas, throughput increases linearly.
- Crash safety: lease expiry + resume (T07) guarantees no lost workflows.
- Fair scheduling: bulkhead prevents tenant monopoly.
- API protection: rate limiter stops runaway clients before they saturate the queue.

**Negative:**
- Workers add operational complexity (separate deployment, separate logs).
- Postgres queue has higher latency than Redis-based queues (~5–20 ms per dequeue vs <1 ms).
- `BYPASSRLS` requirement for the worker role is a security-sensitive configuration.

## Rejected Alternatives

- **Redis Streams**: excellent for high-throughput queues but adds a second stateful
  infrastructure component. Postgres is sufficient for the current scale.
- **BullMQ**: good DX but pulls in Redis as a hard dependency and adds significant
  abstraction over the queue port.
- **In-process queue (EventEmitter)**: no crash recovery, no horizontal scaling.
- **Namespace per tenant** for queue isolation: doesn't scale (schema proliferation).
