# ADR 0004 — Server Transport: HTTP + WebSocket

**Status:** Accepted
**Date:** 2026-08-07
**Branch:** `feat/04-server-transport-ws`

## Context

After T03 we have a complete agent execution core. What we do not have is any way to
start a workflow or observe it. T04 exposes the harness through two transports:

1. **HTTP (Fastify)** for starting workflows and polling state/events.
2. **WebSocket (`ws`)** for real-time streaming of `HarnessEvent` objects to clients
   that need to render a live execution trace (the Inspector UI built in T05).

Key constraints:
- The HTTP controller must import **zero domain logic** (no reducer, no budget maths).
- WS clients must be able to **reconnect** and receive a complete event history with
  no gaps and no duplicates. This is mandatory: the Inspector, opened in a new tab
  after a workflow started, must see all events from the beginning.
- A **slow consumer** (JS tab in a background, mobile on 3G) must not block the
  runtime loop. The runtime is synchronous inside each step; it cannot wait for a
  back-pressured WS send.

## Decision

### 1. `HarnessRuntime.run()` uses `task.id` as the workflow ID

**Previous behaviour:** the runtime called `idPort.newId()` internally, which meant
callers could not know the workflow ID before the runtime started.

**New behaviour:** `workflowId = task.id`. The service generates the ID before
firing `runtime.run()`, so it can return `{ workflowId }` in the same synchronous
call that kicks off the workflow.

No existing tests broke: they check `state.status` and event types, not the workflow
ID value.

### 2. `EventBus` — in-process Observer

```
HarnessEvent → EventLog.append → CompositeEventLog → [InMemoryEventLog, EventBus.publish]
                                                               ↓
                                                     WsConnection.deliver
```

`EventBus` is a `Map<workflowId, Set<EventHandler>>`. The runtime publishes into
`CompositeEventLog`, which fans out to both the durable log and the in-process bus.

**Why not emit directly from the runtime?** The runtime knows nothing about transports.
Adding a bus subscription is a zero-change operation on `HarnessRuntime`.

### 3. `CompositeEventLog` — Decorator / Composite

Wraps any `EventLogPort` and an `EventBusPort`. Publishes **after** the inner
`append` resolves, so observers only see events that are durably stored. In T06,
swapping `InMemoryEventLog` for `PostgresEventLog` requires zero changes here.

### 4. Subscribe / replay protocol (race-condition safe)

The WS subscribe flow guarantees no gaps and no duplicates under concurrent
publish/replay:

```
Step 1:  Subscribe to live bus first → buffer live events in memory
Step 2:  Replay historical from EventLog (seq >= lastSeq)
Step 3:  Set replaying = false; drain buffered events with seq > lastReplayedSeq
Step 4:  Real-time delivery from bus
```

The race: without step 1, an event published between steps 2 and 3 would be lost.
Buffering during replay and then filtering by seq removes both the race and duplicates.

### 5. Backpressure — per-connection buffer

Each `WsConnection` holds a `liveBuffer` of max 100 events during the replay phase.
If the buffer overflows, the connection sends `stream.lagged` and unsubscribes from
the bus. The client must re-fetch via `GET /workflows/:id/events?fromSeq=` and
re-subscribe. The runtime is **never blocked**: `bus.publish()` is synchronous
and returns immediately.

### 6. `HarnessService` — Facade

Controllers see a three-method interface:

```typescript
start(opts: StartWorkflowOptions): StartWorkflowResult   // fire-and-forget
getState(id: string): Promise<WorkflowState | undefined>
getEvents(id: string, fromSeq?: number): Promise<readonly HarnessEvent[]>
```

This is the only import controllers use from the application layer. The facade
hides `HarnessRuntime`, `InMemoryEventLog`, `InMemoryStateStore`, and `IdPort`.

### 7. RFC 9457 Problem Details for HTTP errors

All error responses use `Content-Type: application/problem+json` with the standard
`{ type, title, status, detail, instance }` shape. The client never has to guess
whether an error body is a string, array, or object.

### 8. WS contract in Zod (`packages/contracts/src/ws.ts`)

The WS message schemas live in `@harness/contracts/ws` — the same package the
frontend will import. This is the **single source of truth** for the wire protocol:
no separate OpenAPI spec, no manual sync between client and server.

### 9. Composition root uses in-memory adapters + `StubModelPort`

For T04, `compose.ts` wires `InMemoryEventLog`, `InMemoryStateStore`, and a
`StubModelPort` that immediately returns a text response. This proves the server
is runnable without a database or LLM API key. The real adapters arrive in T06
(Postgres) and T05 (LLM). Neither requires any change to `HarnessRuntime`.

## Rejected alternatives

- **SSE instead of WS** — SSE is simpler but unidirectional. The Inspector needs to
  send the subscribe message with `lastSeq` for resume; that requires bidirectional
  communication (or a separate REST call to set up the session, which is more complex).
- **Pub/sub via Redis** — overkill for a single-process T04. EventBus is a ten-line
  in-process implementation that can be replaced by a Redis adapter in T09 without
  touching `HarnessRuntime` or `HarnessService`.
- **Server-generated workflow ID** (old `idPort.newId()`) — the `start()` method
  is fire-and-forget. Without knowing the ID before firing, the service cannot return
  it synchronously. Awaiting the runtime to get the ID breaks the fire-and-forget
  contract and forces the HTTP response to wait for the first checkpoint.
- **Poll-only (no WS)** — the Inspector is supposed to show live steps. A poll
  interval of 1 s means a 1 s lag for every event. The point of the Inspector is
  observability; polling defeats it.

## Consequences

- ✅ `POST /workflows` returns 202 + `workflowId` synchronously; events stream live.
- ✅ WS reconnect is gap-free and duplicate-free by design (not by luck).
- ✅ Slow consumer → `stream.lagged` → client self-heals via REST refetch. Runtime
  is never blocked.
- ✅ Controllers import only types from `@harness/core` — zero domain logic.
- ✅ WS contract is a Zod schema shared with the frontend (T05 imports it directly).
- ✅ Swapping in-memory adapters for Postgres (T06) and LLM (T05) touches only
  `compose.ts` — zero changes in runtime, service, or routes.
- ⚠️ `StubModelPort` immediately returns "done" — not useful for real LLM demos
  until T05 implements the real adapter.
- ⚠️ In-memory adapters lose all data on restart — expected until T06.
