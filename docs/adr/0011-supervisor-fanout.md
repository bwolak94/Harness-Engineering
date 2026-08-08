# ADR 0011 — Supervisor and Fan-Out (T11)

**Status:** Accepted
**Branch:** `feat/11-supervisor-fanout`
**Depends on:** ADR 0010 (routing and handoffs)

---

## Context

Once routing selects a specialist agent, some tasks are inherently parallel: evaluating N candidates
independently, running N financial scenarios, or screening a batch of job applicants. Naïve
serial execution multiplies latency by N. But naive parallelism has its own failure mode: one
failing subagent can bring down the whole operation.

The other failure mode is invisible: running subagents with shared context (no isolation) means
candidate X's evaluation influences candidate Y's score. For HR tooling (N6) this is not just
a performance problem — it is a fairness problem.

---

## Decision

### Supervisor — Scatter-Gather with Graceful Degradation

`Supervisor.fanOut<T>` accepts an array of `SubagentTask<T>` and runs them with:

1. **Concurrency limit** — a proper semaphore, not round-robin batching. A slot frees as soon
   as its task finishes, so slow tasks do not block fast sibling slots.
2. **AbortSignal propagation** — parent `AbortController` linked to each child. Cancelling the
   parent propagates to every running child within one polling cycle (≤ `timeoutMs` or the
   task's own internal sleep interval).
3. **Budget distribution** — parent `Budget` divided evenly among N tasks. Each task receives
   at most `budget/n`. Sums are always ≤ parent budget.
4. **Never throws** — every task outcome is captured as `SubagentResult<T>`:
   `{ status: "success" | "failed", taskId, value | reason }`.
5. **`FanOutResult.partial`** — set `true` when at least one task failed. Caller decides
   whether `partial` maps to `completed_partial` or an error.

**Rationale:** Tasks are independent; any subset can fail without blocking synthesis of the rest.
Three of five returning is better than zero of five. This is the Graceful Degradation principle
applied structurally, not as a `try/catch` afterthought.

### Composite — Supervisor implements SubagentTask

`Supervisor` itself can be wrapped as a `SubagentTask<FanOutResult<T>>`:
```typescript
const nestedTask: SubagentTask<FanOutResult<Candidate>> = {
  taskId: "nested-supervisor",
  execute: (signal) => outerSupervisor.fanOut(innerTasks, { signal }),
};
```
No special code required — the interface is the same at every nesting level (LSP).

### N6 screenCandidates — deterministic per-candidate scoring

Each candidate is scored by a pure function (`scoreCandidate`) that reads only the job spec
and that candidate's own data. The Supervisor runs N of these in parallel.

**Invariant**: `score(candidate, jobSpec)` is referentially transparent — identical input,
identical output, regardless of which other candidates appear in the batch. This is the proof
of context isolation required by the DoD.

Score formula (all dimensions on [0, 1], then weighted sum → [0, 100]):
- `mustHave`: matched must-have skills / total must-have skills
- `niceToHave`: matched nice-to-have skills / total nice-to-have skills (1.0 if none required)
- `seniority`: derived from the highest experience level in the candidate's history

### New workflow events (T11)

| Event | When emitted | Reducer effect |
|---|---|---|
| `subagent.started` | Fan-out begins for a task | advance seq |
| `subagent.completed` | Task returns success | advance seq |
| `subagent.failed` | Task returns failure | advance seq |
| `supervisor.synthesized` | All tasks collected | advance seq |

All four are observability events (advance seq, no status change). The `partial` flag is
surfaced through `FanOutResult`, not through workflow status transitions — the outer workflow
decides what `partial` means for its domain.

`TaskPacket` gains an optional `parentWorkflowId` so subagent workflows can be linked to
their parent in the Inspector tree.

`WorkflowStatus` gains `completed_partial` for workflows whose synthesis was partial.

---

## Consequences

- `HarnessRuntime` is unchanged — the Supervisor is a standalone utility, not embedded in
  the runtime loop.
- N6 output is deterministically verifiable without a model call — suitable for regression
  snapshots in T14.
- The `SubagentTask` interface is the extension point: plug in a full `HarnessRuntime` instance
  (T12 approval path, budget propagation) or a plain async function.
- `completed_partial` is a terminal workflow status, making partial completion observable
  in the event log and Inspector.

---

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Batch-round-robin instead of semaphore | Fast tasks waste their slot waiting for a slow sibling in the same batch |
| `Promise.allSettled` without concurrency limit | 50 candidates = 50 parallel model calls; concurrency limit prevents thundering herd |
| Shared scoring context across candidates | Breaks context isolation — N6 fairness invariant violated |
| Throwing on first subagent failure | "All or nothing" defeats the purpose of fan-out for batch operations |
