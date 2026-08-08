# ADR 0009 — Memory & Context Hydration

**Status:** Accepted
**Date:** 2026-08-08
**Branch:** `feat/09-memory-context-hydration`

## Context

After T08 the harness can execute arbitrary computation in a sandbox. T09 addresses the
fundamental context management problem: naively appending every message to the conversation
history causes the context window to grow without bound, increasing cost per step and
eventually hitting the provider's context limit.

Two tools drive the concrete scenario:
- **N10 `proposeRepricing`**: catalogue of 5 000 SKUs — tool result alone exceeds the context
  window of most models.
- **N1 `analyzeInvestment`**: a multi-page valuation report as input — a single user message
  can exceed the budget before the agent makes one tool call.

The failure mode is not gradual: the moment the context overflows, the model call fails with
`context_length` — there is no graceful fallback in the naive implementation.

## Three concepts that naive implementations conflate

| Concept | What it is | Persistence |
|---|---|---|
| **History** | Complete, immutable record of everything that happened | Event log (T06) |
| **State** | Derived facts about the workflow (seq, status, budget) | State store (T06) |
| **Context** | What *this step* sends to the model | Built fresh each turn |

Context is a **view** over history, shaped by the current token budget. History never changes.
Context is always computed from history, never stored as the source of truth.

## Decision

### 1. ContextHydrator — Builder/Pipeline

`ContextHydrator.build(input: HydrationInput): HydrationResult` assembles the model context
in a fixed pipeline order:

```
[system] → [facts?] → [summaries?] → [first-user (goal)] → [recent-turns…]
```

Each section has an independent token budget. Sections that exceed their budget are
**truncated, not dropped** — the model always sees something from each section.

The `system` message and tool schemas are the **stable prefix**. A hash of these two is
included in every `context.hydrated` event. If the hash is identical between consecutive
steps, the provider's prompt cache hits — this directly reduces cost and latency.

### 2. EvictionPolicy — Strategy pattern

The hydrator selects which conversation turns to include via `selectRecentTurns()`:
- The first user message (the task goal) is **always** kept.
- Remaining messages are selected from newest-first until the `recentTurnsTokens` budget is
  exhausted.
- Messages that don't fit are returned as `evictedMessages`.

The eviction logic is a separate, testable function (not entangled with the hydrator).
Replacing it with relevance-based retrieval requires changing only this function.

### 3. MemoryStorePort — Cache-Aside

A new port `MemoryStorePort` stores three kinds of memory:
- **Facts**: persistent key-value pairs (set by runtime, survive across turns).
- **Summaries**: compressed history blobs produced by the Summarizer.

The `NoopMemoryStore` (in core, zero deps) returns empty results. The in-memory implementation
`InMemoryMemoryStore` lives in `packages/adapters-memory`.

A Postgres-backed implementation (`PostgresMemoryStore`) is deferred — the port is the
API surface.

### 4. SummarizerPort — Strategy pattern

`SummarizerPort.summarize(workflowId, messages): Promise<string>` compresses evicted messages.
The `NoopSummarizer` returns a placeholder stub without calling a model, making unit tests free.

Summarization is triggered when `evictedMessages.length >= summarizationThreshold` (default: 5).

The summary is:
1. Stored in `MemoryStore`.
2. Written to the event log as `context.summarized` — so resume can replay it into the store
   without calling the model again (cost = 0 on replay).

### 5. context.hydrated and context.summarized events

Two new `HarnessEvent` variants:

**`context.hydrated`** — emitted before every model call.
```
payload: { tokensBySection, totalTokens, prefixHash, evictedCount }
```
Visible in the inspector as a per-step token breakdown. Allows auditing cache behaviour.

**`context.summarized`** — emitted when the Summarizer fires.
```
payload: { summaryId, fromSeq, toSeq, messageCount, summary }
```
On resume, the runtime re-hydrates `MemoryStore` from these events before entering the loop.
This is the Cache-Aside pattern: populate from event log on first read, then serve from store.

### 6. Integration with HarnessRuntime

`HarnessRuntimeDeps` gains three optional fields:
- `memoryStore?: MemoryStorePort` (default: `NoopMemoryStore`)
- `summarizer?: SummarizerPort` (default: `NoopSummarizer`)
- `contextBudget?: ContextBudget` (default: `DEFAULT_CONTEXT_BUDGET`)

The run loop becomes:
```
hydrate(history, facts, summaries) →
  if evicted >= threshold: summarize + store + emit context.summarized →
  emit context.hydrated →
  model.generate(prunedMessages) →
  ... (rest unchanged)
```

## Token budget defaults

| Section | Default tokens | Rationale |
|---|---|---|
| system | 1 000 | Instruction prompts rarely exceed this |
| facts | 500 | Key-value facts are concise |
| summaries | 2 000 | Compressed history |
| recent turns | 8 000 | Main conversation budget |
| **total** | **11 500** | Well within a 16k context window |

## Consequences

**Good:**
- Context size is bounded regardless of workflow length (200-step test passes).
- Stable prefix hash enables provider cache hits — measurable cost reduction.
- Summarization saves compressed history to the event log — resume doesn't call the model.
- `MemoryStorePort` allows a Postgres-backed implementation without changing domain code.
- Strategy pattern for eviction: swap in relevance-based retrieval (T14 evals) without
  touching `HarnessRuntime`.

**Trade-offs:**
- Token estimation uses `1 token ≈ 4 chars` (rough, sufficient for budget enforcement).
  Production systems should use a tokenizer library — the port abstraction allows this.
- Summaries produced by `NoopSummarizer` are placeholders. A real `ModelSummarizer` adapter
  (deferred) would use a cheap model (e.g. haiku-class) for compression.
- `context.hydrated` events add ~1 event per LLM call to the log. Acceptable overhead.

## Alternatives considered

**Single sliding window (no summarizer)**: simpler, but loses information from early turns.
Rejected because N10 with 5 000 SKUs means the first tool result alone overflows — summarization
is not optional for the target workload.

**Semantic retrieval (embeddings)**: most accurate but requires a vector store (out of scope for T09).
The `EvictionPolicy` abstraction makes this a drop-in replacement in T14.

**Context stored as state (not rebuilt each turn)**: blurs the History/State/Context separation.
Rejected — context is always a derived view; storing it as state creates a second source of
truth that can drift.
