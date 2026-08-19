# ADR-0020: Product Design Co-Pilot — Tool Set

**Status:** Accepted
**Date:** 2026-08-19

## Context

Harness Engineering currently has tools covering financial analysis, logistics, HR, and energy
domains (N1–N16). To extend the harness into hardware/product design workflows, we need a suite
of deterministic, LLM-free computation tools that ground multi-step design sessions in real
constraints — preventing the model from fabricating cost figures, weight budgets, or feasibility
verdicts.

A product design co-pilot session typically follows:

1. Parse requirements → 2. Search patents / prior art → 3. Query material/component specs →
   **4. Estimate unit cost at scale** → **5. Check design feasibility** →
   **6. Estimate product weight** → 7. Produce final BOM + design rationale

Steps 4–6 are pure computation; they are the hardest to reason about correctly and the easiest
to hallucinate numbers for. We implement them as harness tools so every figure in the final
design report is grounded in an auditable tool call.

## Decision

Add three new tools to `packages/contracts` and `packages/core`:

| ID | Name | What it computes |
|----|------|-----------------|
| N13 | `estimateProductionCost` | Unit cost from BOM + labour at multiple production volumes; tooling amortisation; gross-margin projection |
| N14 | `checkDesignFeasibility` | Scores a design against requirements (weight, size, IP rating, temp range, cost); emits hard/soft violations and recommendations |
| N15 | `estimateProductWeight` | Aggregates per-component masses; identifies heaviest contributors; checks against a weight budget |

All three are:
- **Pure functions** — zero I/O, no external calls, no `process.env` reads.
- **Deterministic** — given the same inputs they return the same output; safe to cache.
- **Idempotent** — marked `idempotent: true` in the registry.
- **Zero-dependency additions** — no new npm packages required.

They join `createDefaultToolExecutors()` with the standard decorator stack
(timeout → truncation → telemetry).

## Rejected alternatives

- **Calling external APIs (e.g. Octopart, DigiKey) from within the tool** — violates the
  `packages/core` zero-I/O rule; would need an adapter port. Deferred to a future task where
  a `ComponentCataloguePort` would inject live pricing.
- **Combining all three into one "designSummary" mega-tool** — conflicts with single-responsibility
  principle; the model benefits from calling them independently so it can react to each result.
- **Shipping only N13 initially** — N14 (feasibility) is the most safety-critical: without it
  the model has no way to flag physically impossible designs, making the co-pilot unsafe to use.

## Consequences

- ✅ The harness can now run a complete product costing + feasibility check without any LLM
  guessing — all numbers are traceable to tool call events in the event log.
- ✅ Three new domains (manufacturing, mechanical engineering, product management) are served
  with no new infrastructure.
- ✅ Memory store accumulates design facts across a multi-day session; context hydration
  reconstructs design history without resending the full BOM every turn.
- ⚠️ Cost figures use caller-supplied unit costs; the harness does not validate them against
  market data. A future `ComponentCataloguePort` adapter would close this gap.
- ⚠️ IP-rating material compatibility is implemented with a simplified lookup table;
  edge cases in exotic materials require a richer database.
