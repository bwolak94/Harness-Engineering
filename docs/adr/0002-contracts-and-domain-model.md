# ADR 0002 — Contracts and Domain Model

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** Project team / architect agent
**Task:** T01

## Context

We need to define the system vocabulary — all types that cross process boundaries (WebSocket, DB,
LLM) — before any logic is written. Two risks drive this task:

1. **Type drift**: when TypeScript types and runtime validation diverge, bugs appear at the worst
   possible moment (inside a live agent loop). The only solution is a single source of truth.
2. **Stringly-typed IDs**: a system with WorkflowId, StepId, ToolName and plain `string` everywhere
   will misplace arguments. The TypeScript compiler must catch this.

## Decision

### Schema-first with Zod v3 + zod-to-json-schema

The plan specifies Zod v4 (`z.toJSONSchema`), but Zod v4 introduces breaking API changes that
would require migrating `packages/contracts/src/env.ts` (already shipping and tested). We use
**Zod v3 + `zod-to-json-schema`** for now:
- Same single source of truth: Zod schema → TypeScript type → JSON Schema for LLM tool definitions.
- Migration to Zod v4 is a one-line version bump + minor API changes — worth doing in a dedicated
  chore once all schemas are stable.

### Dependency direction

`packages/contracts` ← `packages/core` (core imports contracts, never the reverse).
Contracts use plain `string` for all IDs; branded types live only in core/domain.

### HarnessEvent as a discriminated union

Ten event variants, each with a `type` literal field. The `default: assertNever(event)` branch in
the reducer guarantees that adding a new variant without handling it breaks the build. This is
Open/Closed Principle enforced by the type system.

### Pure reducer in core/domain

`reduce(state, event): WorkflowState` is a pure function with no I/O. It can run in the server
(T06 event sourcing) and in the browser (T05 UI state) without modification. The reducer never
decrements `seq` — a property-based test (fast-check) verifies this for arbitrary event sequences.

### Value objects with constructor validation

`TokenCount`, `Cost`, `StepIndex` are classes with private constructors and `create()` returning
`Result<T, string>`. This moves invariant checks from scattered `if`-guards to the type itself.

### Tool schemas in contracts

All N1–N11 tool input/output schemas live in `packages/contracts/src/tools/`. No implementations
(those arrive in T03). The registry exports every schema plus its JSON Schema representation,
so the LLM tool-calling layer always has the latest definition automatically.

## Consequences

- Every new `HarnessEvent` variant requires a handler in the reducer — enforced at compile time.
- Changing a tool schema automatically updates the JSON Schema sent to the LLM — no manual sync.
- `packages/core` has zero `import` from `packages/contracts` in the reverse direction.
- Upgrading to Zod v4 becomes possible in a future chore with zero logic changes.
- `zod-to-json-schema` adds one runtime dependency to `packages/contracts`.

## Rejected alternatives

- **Zod v4 now**: too many simultaneous changes; risks breaking the already-working env validation
  before the domain layer is even tested.
- **Manual JSON Schema files**: diverge from TypeScript types immediately; violates DRY.
- **io-ts / Effect Schema**: unfamiliar to most TypeScript developers; adds cognitive overhead with
  no benefit over Zod for this project's needs.
- **Branded types in contracts (via Zod `.brand()`)**: would require core to import branded schemas
  from contracts, creating a circular reasoning problem. Kept in core as pure TypeScript only.
