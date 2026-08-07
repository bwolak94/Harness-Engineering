# ADR 0006 — Event Log Persistence

**Status:** Accepted
**Date:** 2026-08-07
**Branch:** `feat/06-event-log-persistence`

## Context

After T05 the system works end-to-end but all state lives in process memory. Restarting the server loses every workflow. T06 replaces the in-memory adapters with Postgres-backed implementations — **without touching a single line in `packages/core`**. This is the litmus test for the hexagonal architecture established in T02.

Key constraints from plan.md:
1. `git diff main -- packages/core` must be **empty** after this branch.
2. `events` table is append-only — enforced at the DB level, not by convention.
3. Optimistic concurrency: concurrent writes fail fast with a typed error, not silently.
4. Snapshots every N events: restoring 10 000 events stays under 100 ms.
5. Contract tests: the same test suite must pass for both InMemoryEventLog and PostgresEventLog.

## Decision

### 1. Event Sourcing + Snapshot pattern

```
events table (append-only)          snapshots table (every 50 events)
┌────────────────────────────┐      ┌────────────────────────────┐
│ id, workflow_id, seq, type │      │ id, workflow_id, seq, state│
│ at, payload (jsonb)        │      │ created_at                 │
│ UNIQUE (workflow_id, seq)  │      └────────────────────────────┘
└────────────────────────────┘
                                    workflows table (version only)
                                    ┌────────────────────────────┐
                                    │ id, version                │
                                    │ created_at, updated_at     │
                                    └────────────────────────────┘
```

`load(workflowId)`:
1. Read latest snapshot (O(1)).
2. Read events with `seq >= snapshot.seq + 1`.
3. Replay events through `reduce()` — same function as the server uses at runtime.
4. Return `{ state, version }`.

`save(workflowId, state, expectedVersion)`:
1. INSERT (first save) or UPDATE WHERE version = expectedVersion.
2. If UPDATE returns 0 rows → `ConcurrentWriteError`.
3. If `(state.seq + 1) % SNAPSHOT_EVERY === 0` → INSERT snapshot.

### 2. Append-only enforcement

A Postgres trigger `events_immutable` calls a function that raises an exception on any UPDATE or DELETE on the `events` table. The restriction lives in the DB, not in application code — survives any future adapter or migration.

### 3. Optimistic concurrency

`workflows.version` starts at 0. Each successful `save()` increments it by 1. The UPDATE uses `WHERE id = ? AND version = expectedVersion`; zero rows updated = concurrent writer was faster.

For the first save (`expectedVersion = 0`), an INSERT is attempted inside a transaction. Duplicate-key violation → another process won the race → `ConcurrentWriteError`.

### 4. Drizzle ORM + manual migrations

Schema is defined with Drizzle ORM (`drizzle-orm/pg-core`) for type-safe query building. Migrations are plain SQL files tracked by drizzle-kit (`pnpm db:migrate`).

Migration `0001_initial.sql` creates all tables, indices, the append-only trigger, and the `__drizzle_migrations` tracking table.

### 5. Contract tests via Testcontainers

A single `definePortContracts()` factory function creates identical describe blocks for both adapters:

```
definePortContracts("InMemory", { ... InMemoryEventLog + InMemoryStateStore ... });
definePortContracts("Postgres", { ... PostgresEventLog + PostgresStateStore + Testcontainers ... });
```

Same test code, same assertions, two adapters. Any behavioural divergence between the fake and the real implementation fails CI.

## Rejected alternatives

- **Storing computed state in a `state` JSONB column on `workflows`**: simpler for `load()` but breaks Event Sourcing — history is no longer the source of truth. Snapshots achieve the same performance without the architectural trade-off.
- **Triggers via application-level check in `append()`**: survives refactors but not direct DB access. The trigger is the only option that holds for all writers.
- **Separate contract test files per adapter**: duplicates tests. A factory function keeps them identical by construction.

## Consequences

- ✅ `git diff main -- packages/core` is empty — hexagonal architecture is real.
- ✅ Append-only invariant enforced by the DB, not by developer discipline.
- ✅ Concurrent writes fail fast and explicitly — no silent data corruption.
- ✅ 10 000-event restore < 100 ms with snapshots every 50 events.
- ✅ Same contract test suite validates both adapters; the in-memory fake is no longer a lie.
- ⚠️ Testcontainers tests require Docker — CI pipeline must have Docker-in-Docker or a Docker socket.
- ⚠️ `pnpm db:migrate` must be run before starting the server in production or integration tests.
