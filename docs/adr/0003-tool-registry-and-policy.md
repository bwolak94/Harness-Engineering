# ADR 0003 — Tool Registry, Decorator Chain and Policy Specification

**Status:** Accepted
**Date:** 2026-08-07
**Branch:** `feat/03-tool-registry-and-policy`

## Context

After T02 we have a runtime loop that calls `ToolRegistryPort.get(name).execute(args)`.
The runtime knows nothing about which tools exist — that is correct. But we need to answer
several new questions:

1. **Validation**: who ensures `args` match the tool's contract before the model's output reaches
   domain logic? Doing it inside every `execute` is repetitive and easy to forget.
2. **Timeouts**: some tools will block indefinitely under adversarial input. AbortSignal must be
   propagated and enforced.
3. **Policy**: a tool marked `dangerous: true` must require explicit human approval before it
   executes. This rule must be enforced regardless of which code path reaches the tool.
4. **Truncation**: tools returning 1 MB payloads must be capped before the result enters the
   LLM context window (which is finite and expensive).
5. **Tool definitions**: four business-domain tools (N1, N3, N9, N10) must be implemented as
   pure-computation functions with no I/O. They serve as the portfolio stress-test for the
   harness: one runtime, four industries, zero external calls.

## Decision

### 1. `Tool<TInput, TOutput>` — typed definition

A generic interface that carries the Zod schema alongside `execute`. The Zod schema is the
single source of truth: it validates at runtime, documents the contract for the model, and
generates JSON Schema for the LLM provider.

```
Tool<TInput, TOutput>  →  asExecutor()  →  ToolExecutor  →  decorators  →  registry
```

`asExecutor()` is the adapter that converts the typed interface to the untyped runtime boundary.

### 2. Decorator pattern for cross-cutting concerns

`ToolExecutorDecorator = (executor: ToolExecutor) => ToolExecutor` — composable, order-significant.

Recommended order: `withPolicy → withValidation → withTimeout → withResultTruncation → withTelemetry`
(policy gate first; telemetry last so it measures everything including policy cost).

Each decorator is independently testable and can be added/removed without touching any other.

### 3. `ToolPolicy` — Specification pattern

```typescript
interface ToolPolicy {
  evaluate(args: unknown, def: ToolDefinition): PolicyDecision;  // "allow" | "deny" | "requireApproval"
  and(other: ToolPolicy): ToolPolicy;
  or(other: ToolPolicy): ToolPolicy;
  not(): ToolPolicy;
}
```

Policies are composable objects. A runtime can express "dangerous AND not yet approved" as
`isDangerous().and(notApproved())` without any if-chain in the loop. T12 (HITL) will extend
this with actual approval state.

### 4. `withTimeout` and `AbortSignal` propagation

`ToolExecutor.execute` gains an optional `AbortSignal` parameter (backwards-compatible).
`withTimeout(ms)` races execution against a timer that fires `AbortController.abort()`.
The inner tool receives the signal and is expected to honour it; for pure-computation tools
the race itself provides the safety net.

### 5. `withResultTruncation` — structure-preserving truncation

Never a raw `.slice()`. The truncation utility serialises the result to JSON, then if it exceeds
the character budget, emits `head (N chars) … [TRUNCATED: original M chars, showing N] … tail (N chars)`.
Head+tail ensures the model sees both the beginning and end of structured responses.

### 6. Tool implementations in `packages/core/src/tools/`

N1, N3, N9, N10 are pure computation (no network, no filesystem, no randomness except in
fixture providers). They depend only on `@harness/contracts` (for Zod schemas and data tables).
Placing them in `packages/core` is consistent with the zero-I/O invariant.

Fixture providers for each tool expose a `flaky` mode (configurable error rate) to enable
chaos/circuit-breaker tests in T08.

### 7. `runCode` stub

`packages/core/src/tools/run-code.ts` registers a tool that always returns
`{ code: "NOT_IMPLEMENTED", ... }`. T08 replaces it with the real sandbox without touching
any other file.

### 8. Zod added to `packages/core` dependencies

`withValidation` needs `z.ZodType<TInput>` from the call site. Adding `zod` explicitly to
core's `package.json` is cleaner than relying on pnpm hoisting of a transitive dependency.
Zod is a pure-validation library with no I/O — consistent with the zero-I/O invariant.

## Rejected alternatives

- **Validate inside `execute`** — each tool author must remember to do it; easy to omit, leads
  to runtime surprises reaching the model.
- **Single ToolRegistry class with built-in decorator logic** — couples registration to decoration.
  Composing decorators outside the registry keeps each concern isolated and testable.
- **Policy as middleware (runtime level)** — would live in the middleware chain. But policy needs
  the tool definition (name, dangerous flag), which only the registry knows. Tool-level policy
  is the right granularity.
- **Tools in a separate `packages/tools` package** — no I/O means no benefit from isolation;
  adds a package.json + tsconfig to maintain for no architectural gain at this stage.

## Consequences

- ✅ Adding a new tool = one file + one registration call in `tools/index.ts`. Zero changes in
  `HarnessRuntime` or any other existing file.
- ✅ Policy violations surface as structured `ToolCallError` (data for the model), not exceptions.
- ✅ Timeout tests are deterministic (AbortController can be fired immediately in tests).
- ⚠️ `withTimeout` uses `Promise.race`, which leaves the inner promise "floating" if the inner
  tool does not honour `AbortSignal`. Pure-computation tools are safe; I/O tools (T06+) must
  implement signal handling explicitly.
- ⚠️ Truncation changes the shape of the result as seen by the model. The model prompt must note
  that results may be truncated and instruct the model to acknowledge the marker.
