# ADR 0008 — Secure Sandbox: Strategy, Bulkhead, Circuit Breaker

**Status:** Accepted
**Date:** 2026-08-08
**Branch:** `feat/08-secure-sandbox`

## Context

After T07 the harness can execute tools durably. T08 adds the ability for the model to write and execute arbitrary JavaScript code. Without isolation, a single `runCode` call can:

- Read or write the filesystem (`require('fs')`)
- Spawn child processes (`require('child_process')`)
- Make outbound network requests (`fetch`, `XMLHttpRequest`, `require('net')`)
- Run infinite loops that hang the server
- Leak memory until OOM kills the process
- Call `process.exit()` to kill the entire server

This is not a hypothetical — prompt injection via retrieved documents can embed instructions that cause the model to run malicious code. The sandbox is the boundary between "data the model processes" and "instructions the model executes".

Two tools require real compute time and are the designated stress tests for the sandbox:
- **N8 `simulatePVPayback`**: 8760-step hourly PV simulation (the only "legitimately slow" tool)
- **N2 `optimizeRoute`**: nearest-neighbour + 2-opt on NP-hard VRP (anytime algorithm)

## Threat Model

| Threat | Mitigation |
|---|---|
| Filesystem access | No `fs`, `path` etc. in VM context; custom `require` stub enforces allowlist |
| Network access | No `fetch`, `XMLHttpRequest`, `http`, `net` in VM context |
| Process termination | `process.exit()` intercepted in VM context; throws instead of exiting |
| Infinite loop | `vm.Script` timeout + hard worker `terminate()` deadline |
| Memory exhaustion | `resourceLimits.maxOldGenerationSizeMb` on the worker (V8 heap limit) |
| Worker crash propagation | Worker thread isolation: crash or OOM kills only the worker, not the main process |
| Prompt injection via tool results | `runCode` receives model-generated code; all output is data, never re-executed as instructions |
| Module allowlist bypass | Only modules in `allowedModules[]` may be required; error includes the full allowlist |

**Explicitly out of scope (conscious decision):**
- CPU time limiting beyond the wall-clock timeout (V8 doesn't support per-instruction limits without native addons)
- Memory profiling beyond the V8 heap limit (no `--max-semi-space-size` control per worker)
- Wasm execution (not blocked; acceptable in the current risk profile)
- Filesystem read-only sandbox (addressed by module allowlist; not cgroup-level)

A container-based sandbox (Docker, gVisor) would provide stronger isolation at higher operational complexity. The `SandboxPort` abstraction allows a `ContainerSandbox` to be dropped in without changing any domain code — this is a deliberate architectural hook for production deployment.

## Decision

### 1. SandboxPort — Strategy pattern

A new port `SandboxPort` in `packages/core/src/ports/sandbox.port.ts`:

```
run(code: string, opts: SandboxOptions): Promise<Result<SandboxOutput, SandboxError>>
```

`SandboxError` is a discriminated union with variants the model can act on:

| Code | When | Self-correction hint |
|---|---|---|
| `SYNTAX_ERROR` | Parse failed | Fix line N |
| `TIMEOUT` | Exceeded `timeoutMs` | Reduce computation or split into steps |
| `MEMORY_LIMIT_EXCEEDED` | V8 heap exceeded | Reduce data size |
| `MODULE_NOT_ALLOWED` | Blocked import | Use a different approach (allowed list shown) |
| `EXECUTION_ERROR` | Runtime throw | Fix the error in the message |
| `CIRCUIT_OPEN` | CB tripped | Retry after cooldown |
| `POOL_EXHAUSTED` | Bulkhead full | Try again later |

Two implementations behind the port:

1. **`WorkerThreadSandbox`** — `node:worker_threads` + `node:vm`. Inline worker script (eval: true) avoids dist path resolution issues at test time. Suitable for development and staging.
2. **`NoopSandbox`** (in core, zero deps) — returns `EXECUTION_ERROR` "not configured". Used in environments without sandbox adapter wired up; ensures the model gets a helpful message instead of an unhandled exception.

`ContainerSandbox` is intentionally deferred — the port is the API; the implementation is a deployment detail.

### 2. Inline worker script

The worker code is embedded as a string with `eval: true`. This solves the common "dist vs source" path problem in monorepos (identical issue to T06's `applySchema`): test runners execute TypeScript source directly, so `new URL('./sandbox-worker.js', import.meta.url)` would point to a non-existent compiled file during `vitest run`.

The worker uses CommonJS (`require`), which is the default for `eval: true` workers even in an ESM parent project. The worker's `require` is replaced by a stub that enforces the module allowlist before delegating to the real `require`.

### 3. Two-layer timeout

```
vm.Script timeout (timeoutMs)      ← fires first for synchronous infinite loops
Worker terminate (timeoutMs + 200) ← catches async hangs and vm timeout non-fires
```

The 200ms buffer lets the vm-internal error arrive first, giving a clean `TIMEOUT` message. If the vm error doesn't arrive (e.g. the worker is stuck in native code), `terminate()` fires and the main process records `TIMEOUT`.

### 4. Bulkhead — fixed worker pool

`BulkheadSandbox` wraps any `SandboxPort` with a pool of `poolSize` concurrent executions and a queue of `queueSize`:

```
active < poolSize  → execute immediately
queue < queueSize  → enqueue (waits for a slot)
queue >= queueSize → POOL_EXHAUSTED (instant rejection)
```

Worst-case memory footprint: `poolSize × memoryMb`. With `poolSize=4` and `memoryMb=64`, the sandbox consumes at most 256 MB — bounded and predictable.

### 5. Circuit Breaker — self-healing failure isolation

`CircuitBreakerSandbox` wraps any `SandboxPort`:

```
CLOSED → OPEN  (after failureThreshold consecutive non-timeout failures)
OPEN   → HALF_OPEN (after cooldownMs)
HALF_OPEN → CLOSED (on success) | OPEN (on failure)
```

`TIMEOUT` does **not** count as a failure — a slow sandbox is still alive. Only `EXECUTION_ERROR`, `SYNTAX_ERROR`, `MEMORY_LIMIT_EXCEEDED`, etc. count. This prevents the circuit from opening when the model writes legitimately compute-heavy code.

The `onOpen` callback emits to the harness event log so circuit-open state is visible in the inspector.

### 6. N2 and N8 tool implementations

Both are pure computation in `packages/core/src/tools/` (zero I/O, no sandbox dep):

- **N2 `optimizeRoute`**: haversine distance matrix → nearest-neighbour → time-bounded 2-opt. Returns `quality: "optimal" | "heuristic" | "partial"` to tell the model exactly what it got.
- **N8 `simulatePVPayback`**: 8760-step Liu-Jordan clearsky irradiance model. Panel azimuth uses 0=North convention (schema); converted to South-origin frame for the Liu-Jordan formula. Performance ratio 0.75 included.

The model can call `runCode` to preprocess data for these tools (e.g. generate a custom consumption profile, or implement a domain-specific route scoring function).

### 7. runCode tool update

`createRunCodeTool(definition, deps: { sandbox: SandboxPort })` — the sandbox dep is now explicit. Default is `NoopSandbox`. Composition root wires up `WorkerThreadSandbox` wrapped in `BulkheadSandbox` and `CircuitBreakerSandbox`.

Only JavaScript is supported (the worker script is CJS; TypeScript would require compilation inside the sandbox — out of scope).

## Consequences

**Good:**
- All 16 security tests pass: fs, child_process, net, http, process.exit(), infinite loop, memory, network APIs, syntax errors, runtime errors — all blocked with structured errors.
- Worker crash or OOM cannot kill the main process (worker thread isolation).
- `SandboxPort` allows dropping in `ContainerSandbox` for production with zero domain changes.
- Circuit breaker prevents cascading failures when the sandbox misbehaves.
- Bulkhead bounds memory usage.

**Trade-offs:**
- CJS worker code is embedded as a string — not type-checked by TypeScript. Unit-tested via the security suite instead.
- Memory limit relies on V8's `maxOldGenerationSizeMb` — does not limit total process memory (stack, native addons). Acceptable for the current implementation stage.
- No multi-language support — only JavaScript. Python and other languages require container isolation (deferred).

## Alternatives considered

**`isolated-vm`**: stronger isolation, V8 Isolate per execution, no `require` at all. Rejected because it requires a native addon (`node-gyp`), complicating CI and cross-platform builds. The `SandboxPort` makes it a drop-in upgrade when needed.

**`eval: false` with a separate compiled worker file**: cleaner but breaks during `vitest run` (source is `.ts`, compiled file doesn't exist yet). The inline string approach is less elegant but works identically in both test and production contexts — same as T06's `applySchema`.

**Container sandbox (Docker)**: strongest isolation. Rejected for T08 because it requires Docker in development environments and adds significant latency per execution. Designed for as the production `ContainerSandbox` implementation behind the same port.

**Shared worker pool (permanent workers)**: reusing workers across executions saves spawn time. Rejected because a compromised worker could affect subsequent executions — new worker per call is the only safe choice without a thorough state-reset protocol.
