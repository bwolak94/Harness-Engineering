# ADR 0010 — Routing and Handoffs (T10)

**Status:** Accepted
**Branch:** `feat/10-routing-and-handoffs`
**Depends on:** ADR 0009 (memory/context hydration)

---

## Context

A single agent with all eleven tools produces sub-optimal results: the model's attention is diluted across irrelevant tool descriptions, and tool selection errors increase with the size of the available set. Lesson 5 of the course introduces routing to address this.

The problem has two distinct aspects:

1. **Routing**: given a user intent, select the specialist agent most capable of handling it — before the agent ever sees the task.
2. **Handoff**: an already-running agent decides it needs to transfer the partially-resolved task to a different specialist, carrying only the relevant slice of context.

Both problems share a failure mode: if routing loops (A→B→A) or if a handoff receives a malformed payload, the runtime must not crash — it must either self-heal or suspend gracefully.

---

## Decision

### Router — Chain of Responsibility

The Router is a chain of `RouterLink` implementations tried in order of ascending cost:

1. **RuleBasedClassifier** — keyword matching, sub-millisecond, zero LLM calls.
   Score = keywords matched for best agent / total keywords matched across all agents.
   If score ≥ 0.7 → commit. Ambiguous intents (spread across agents) → pass to next link.

2. **LlmClassifier** — model call with agent descriptions as context.
   If reported confidence ≥ 0.7 → commit. Low confidence → pass to next link.

3. **EscalationClassifier** — always commits with `matchedBy: "escalation"`.
   The caller (T12) interprets this as `workflow.suspended` for human review.

**Rationale:** rules are free and deterministic; the LLM is expensive and probabilistic. The chain ensures the LLM is called only when rules cannot decide. Adding a new classifier (e.g. semantic similarity) requires no change to the Router — pure OCP.

### AgentRegistry — Least Privilege

Three specialist agents, each with a strict tool subset:

| Agent | Tools |
|---|---|
| `financial-analyst` | `analyzeInvestment`, `calculateNetSalary` |
| `operational-analyst` | `optimizeRoute`, `explodeRecipeCost`, `simulatePVPayback` |
| `commercial-analyst` | `calculateLandedCost`, `proposeRepricing` |

`applyRepricing` (N11) is intentionally absent from all agents — it is `dangerous: true` and requires the explicit approval path from T12.

### RoutingGuard — Hop Limit and Cycle Detection

A stateful, per-workflow guard with two failure modes:
- **Cycle**: an agent already visited in the current run is targeted again (A→B→A).
- **Hop limit**: more than `maxHops` (default 5) distinct agents visited.

Both return `{ ok: false }` which the Router converts to an `escalation` decision. The same mechanism as `LoopDetector` in T02 — same pattern, higher abstraction level.

### Handoff — Typed Transfer

`HandoffPayload` carries `contextSlice: unknown` — a token-bounded subset of the conversation history produced by `buildContextSlice()` (reuses `selectRecentTurns` from T09).

**Invariant**: `estimateTokens(contextSlice) < estimateTokens(fullHistory)`. Passing the full history is context copy, not handoff — it defeats the purpose of specialist agents.

The handoff is recorded as an `agent.handoff` event in the event log, making routing decisions visible in the Inspector and replayable.

---

## Consequences

- `HarnessRuntime` is unchanged — routing is a separate layer applied at the composition root.
- Every routing decision is observable (event log) and auditable (reason + confidence stored).
- The LLM classifier is behind a `ModelPort` interface — measurable and swappable in T14 evals.
- EscalationClassifier provides a natural integration point for T12 (HITL) without requiring changes to the Router.

---

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Single `if/else` per agent in the runtime | Breaks OCP — adding an agent modifies the loop |
| Hardcoded routing in `TaskPacket.metadata` | Couples the client to internal agent topology |
| Passing full conversation on handoff | Eliminates the benefit of specialist context windows |
| Embedding routing in the LLM's system prompt | Non-deterministic, not unit-testable, no zero-LLM-call guarantee |
