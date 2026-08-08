# ADR 0007 — Durable Execution: Checkpoint, Idempotency, and Resume

**Status:** Accepted
**Date:** 2026-08-08
**Branch:** `feat/07-durable-execution-resume`

## Context

After T06 the event log and state store are durable. The agent loop in `HarnessRuntime.run()` is not — a SIGKILL between "execute tool" and "append tool.succeeded" causes the tool to run again on resume. For most read-only tools this is harmless, but the N11 `applyRepricing` tool publishes price changes to an external catalogue: re-executing it would apply the same prices twice.

Three categories of tool call exist:

| Category | Example | What to do on crash |
|---|---|---|
| **Idempotent** | `analyzeInvestment`, `calculateNetSalary` | Re-execute freely — same inputs, same outputs |
| **Compensable** | *(none in current scope)* | Re-execute or compensate with a reversal action |
| **Neither (irreversible)** | `applyRepricing` | Exactly-once delivery via Transactional Outbox + idempotency key |

The challenge: the event log gives us at-least-once semantics after a crash (we can always replay from the last checkpoint), but the external system needs effectively-once delivery.

## Decision

### 1. Write-Ahead Log ordering

Every tool execution follows the WAL sequence:

```
append(tool.called)   ← seq recorded in event log
execute(tool)
append(tool.succeeded | tool.failed)
state.checkpointed    ← marks the end of a stable turn
```

A crash at any point is recoverable:
- **Before append(tool.called):** no record → re-execute from scratch on resume.
- **After append(tool.called), before execute:** tool.called without result → in-flight call → re-execute.
- **After execute, before append(tool.succeeded):** same as above — idempotency store prevents duplicate side-effects.
- **After append(tool.succeeded), before checkpoint:** resume replays the event log → result already recorded → skip.

### 2. Idempotency Store

A new port `IdempotencyStorePort` caches tool results keyed by a deterministic idempotency key:

```
key = ${workflowId}:${seq_of_tool_called}:${toolName}
```

Using the `seq` of the `tool.called` event instead of a cryptographic hash:
- Unique within a workflow without additional storage.
- Does not require `node:crypto` (kept out of `packages/core` per architecture invariants).
- Deterministic: the same crash produces the same key on every resume attempt.

The store is checked **before** execution and written **after** execution. This converts at-least-once (the only guarantee after SIGKILL) into effectively-once.

### 3. Transactional Outbox for irreversible actions

N11 `applyRepricing` must not call the catalogue API twice. The pattern:

```
1. Check idempotency store  →  return cached "duplicate" result if found
2. Update local catalogue map
3. Enqueue OutboxItem { action, payload, idempotencyKey, status: "pending" }
4. Cache result in idempotency store
```

A separate outbox worker delivers the item with at-least-once semantics. The catalogue API uses the same `idempotencyKey` for deduplication on its side — at-least-once + idempotency key = effectively-once end-to-end.

Crash safety for N11:
- **Crash before enqueue:** idempotency store has no entry → re-execute → enqueues again → outbox deduplicates by idempotencyKey.
- **Crash after enqueue, before idempotency store write:** re-execute → idempotency store empty → enqueues again → outbox deduplicates (same key, idempotent).
- **Crash after idempotency store write:** resume → store hit → return cached "duplicate" result → no second enqueue.

### 4. Conversation reconstruction

`reconstructConversation(events)` rebuilds the model's message history from the event log:

```
[system] + [user: task.goal]
  + per completed turn: [assistant: toolCalls] + [tool: results]
  + if in-flight turn: [assistant: all calls] + [tool: already-resolved results]
```

A "turn" is bounded by `state.checkpointed` events. Tool calls after the last checkpoint without a matching `tool.succeeded/failed` are "in-flight" and must be re-executed during resume.

Assistant text content is not stored in events; replayed assistant messages use `content: null`. The model only needs tool results, not its own previous text, to continue execution.

### 5. Resume algorithm

`HarnessRuntime.resume(workflowId)`:

1. Load checkpointed state from `StateStorePort`. Throw `WorkflowNotFoundError` if missing.
2. Return immediately if status is terminal (`completed` / `failed` / `halted`).
3. Load all events from `EventLogPort`. Call `reconstructConversation(events)`.
4. **Fast-forward state seq**: replay events with `e.seq > state.seq` through `reduce()` to bring `state.seq` to the true maximum before emitting new events (avoids seq conflicts).
5. Emit `workflow.resumed`.
6. For each in-flight call: check idempotency store → use cached result or re-execute the tool.
7. Emit `tool.succeeded / tool.failed` for each in-flight call.
8. Checkpoint (emit `state.checkpointed` + save snapshot).
9. Continue the normal agent loop.

## Consequences

**Good:**
- SIGKILL at any point in the tool execution cycle is recoverable without data loss.
- Irreversible external effects are delivered exactly once end-to-end.
- No changes to `packages/core` ports required for Postgres adapter (IdempotencyStore + Outbox are new ports, not modifications).
- Chaos test suite (10 kill points × resume) verifies all crash boundaries.

**Trade-offs:**
- Idempotency store must be durable (survives process restart). InMemory adapter is sufficient for tests; production requires a Postgres-backed adapter (deferred to T08).
- Outbox delivery requires a background worker. The current implementation includes the port and in-memory adapter; the actual HTTP worker is a separate concern.
- N11 is not registered in `createDefaultToolExecutors()` because it requires I/O dependencies (`OutboxPort`, `IdempotencyStorePort`, catalogue map). Callers must compose it explicitly at the composition root.
- Assistant text content is lost on resume — acceptable because the model can regenerate text responses from tool results.

## Alternatives considered

**Hash-based idempotency key:** `sha256(workflowId + toolName + JSON.stringify(args))` — rejected because it requires `node:crypto` (blocked in `packages/core` by the `noNodejsModules` biome rule), and two identical calls in the same workflow would produce the same hash even if they should be independent.

**Sagas / compensating transactions:** For compensable operations, a saga pattern would allow rollback. Not implemented because no current tool requires compensation; the architecture is open to adding it later via a `compensate()` method on the Tool interface.

**External idempotency key (caller-supplied):** N11 uses a caller-supplied `idempotencyKey` in the input schema rather than deriving it from the runtime context. This lets the model/caller control deduplication granularity (e.g., "daily repricing batch 2026-08-08") independently of crash recovery.
