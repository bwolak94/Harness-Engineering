# ADR 0003 — Harness Runtime: Ports & Adapters, Middleware Chain, Command Pattern

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** Project team / architect agent
**Task:** T02

## Context

The naive implementation of an agent loop is `while(true) { callLLM(); }`. This has four known
failure modes that make it unfit for production:

1. **No budget enforcement** — a runaway agent burns through tokens/money with no recourse.
2. **No observability** — no record of what happened; debugging requires live reproduction.
3. **No loop protection** — a confused model re-calls the same tool with the same arguments
   indefinitely.
4. **Steps are closures** — cannot be serialised, replayed, or resumed after a crash (blocks T07).

This task removes all four failure modes before any real I/O is wired in.

## Decision

### Hexagonal architecture (Ports & Adapters)

Six port interfaces live in `packages/core/src/ports/` with zero implementations:
- `ModelPort` — the only LLM abstraction; runtime never imports any SDK directly.
- `EventLogPort` — append and read `HarnessEvent` records.
- `StateStorePort` — optimistic-concurrency `load/save` with a version counter.
- `ClockPort` — injectable wall-clock; `FixedClock` makes tests deterministic.
- `IdPort` — injectable ID generator; `SeededIdPort` makes snapshots reproducible.
- `ToolRegistryPort` — register/get/list tool executors.

All six are injected into `HarnessRuntime` at construction — no global singletons, no service
locator. This is DIP from SOLID without a DI container.

### Middleware chain (Chain of Responsibility)

`HarnessMiddleware = (ctx: StepContext, next: () => Promise<void>) => Promise<void>`

Four built-in middlewares compose around every step execution:
- `withBudget` — checks all four budget counters before calling `next()`; short-circuits on
  any exceedance with a structured reason.
- `withLoopDetection` — hashes `(toolName, normalizedArgs)`; at the 3rd repetition injects a
  corrective assistant message and continues (does NOT hard-stop the loop).
- `withEventEmission` — emits `step.planned` / `tool.called` / `tool.succeeded|failed` events
  and drives the state reducer.
- `withTiming` — records wall-clock duration and passes it to the budget enforcer.

Ordering matters and is explicit at the call site (`apps/server/src/composition/`), not
hardcoded in the runtime. A test verifies that reordering produces different observable
behaviour — proving the pipeline is truly composable.

### Step as Command (not a closure)

```typescript
interface Step {
  kind: "tool_call" | "llm_turn" | "finish" | "error_recovery";
  input: unknown;          // always a plain serialisable value
  meta?: Record<string, unknown>;
}
```

`input` is never a function. This is the necessary precondition for durable execution in T07 —
a step that is a closure cannot be written to Postgres and replayed after a crash.

### BudgetEnforcer — four independent counters

`exceeded(budget: Budget): BudgetExceededReason | null` returns a reason string, not a boolean,
so the `workflow.failed` event carries a machine-readable cause.

### LoopDetector — hash + threshold

Normalised JSON (sorted keys) hash of `(toolName, args)`. The threshold (default 3) is
configurable. At threshold, the detector injects a corrective user message into the conversation
and records the injection — the loop continues so the model has a chance to recover.

### FakeModelPort — working fake, not a mock

`FakeModelPort` is a fully working `ModelPort` implementation that replays a scripted queue
of responses. A mock (`vi.fn()`) would only verify that `generate()` was called. A fake verifies
that the entire runtime behaves correctly for a given conversation script — which is the only
meaningful test of an agent loop.

## Consequences

- Adding a new middleware (e.g., T13 tracing) requires zero changes to `HarnessRuntime`.
- Tests run in milliseconds — no network, no LLM cost.
- `packages/core` remains free of I/O dependencies.
- `StateStorePort.save` uses an optimistic-concurrency version — concurrent writes to the same
  workflow are detected and rejected cleanly (important for T07).
- `FixedClock` + `SeededIdPort` make snapshot tests reproducible across machines and CI runs.

## Rejected alternatives

- **Injecting a built-in retry/circuit-breaker** into the runtime: deferred to T08. The runtime
  should be the thinnest possible loop; cross-cutting reliability patterns belong in adapters.
- **Async generator for the event stream**: adds complexity with no benefit at this stage.
  `EventLogPort.append` is sufficient; the stream abstraction arrives with T04 (WebSocket).
- **Class-based middleware**: function-based middleware is simpler to compose and test; no
  `this` binding issues.
