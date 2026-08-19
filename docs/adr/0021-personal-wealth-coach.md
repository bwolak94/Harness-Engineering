# ADR-0021: Personal Wealth Coach — Tool Set

**Status:** Accepted
**Date:** 2026-08-19

## Context

A personal finance agent session spans months or years: transactions accumulate,
retirement projections evolve, and subscription costs creep up unnoticed. Without
deterministic computation tools the LLM is forced to guess at sums, simulate random
outcomes in its head, and invent subscription patterns — all high-risk failure modes
when the output drives real financial decisions.

Three specific failure modes motivate this tool set:

1. **Hallucinated spending summaries** — the model "reads" a transaction list and
   produces plausible-sounding totals that are simply wrong. Grounding in N17 forces
   every figure to trace back to a tool call event in the audit log.

2. **Fabricated retirement projections** — Monte Carlo simulation requires thousands
   of stochastic paths; the model cannot perform this reasoning reliably in-context.
   N18 produces calibrated success-probability and percentile bands.

3. **Invisible subscription creep** — users have dozens of recurring charges that
   incrementally increase or quietly persist. N19 surfaces price drift and potential
   forgotten subscriptions the model would otherwise miss across a long conversation.

## Decision

Add three new tools to `packages/contracts` and `packages/core`:

| ID | Name | What it computes |
|----|------|-----------------|
| N17 | `categorizeTransactions` | Rule-based spending categorisation; monthly trend; anomaly detection |
| N18 | `simulateRetirement` | Monte Carlo (seeded LCG PRNG) success probability, percentile bands, and improvement recommendations |
| N19 | `detectSubscriptionDrift` | Recurring-charge fingerprinting, price-drift alerts, forgotten-subscription flags |

All three:
- **Pure functions** — zero I/O, no external API calls, no `process.env` reads.
- **Deterministic when seeded** — N18 accepts an optional `seed` so tests are
  reproducible; N17 and N19 are fully deterministic for identical inputs.
- Registered in `TOOL_REGISTRY` and wired into `createDefaultToolExecutors()`.
- **No new npm packages** required.

## N18 PRNG design note

Monte Carlo simulation requires a random number source. We use a 64-bit Linear
Congruential Generator (Knuth/MMIX constants) implemented in pure TypeScript with
an optional `seed` parameter (default `Date.now()`). This keeps `packages/core`
dependency-free while providing reproducible results in tests and deterministic
replay across sessions when the seed is stored in the memory store.

## Rejected alternatives

- **Using `Math.random()` in N18** — not seedable; tests would be flaky and
  conversation replay would produce different projections for the same inputs.
- **External financial data APIs** — violates the `packages/core` zero-I/O rule;
  caller-supplied rates are sufficient for planning-level projections.
- **Single "wealthSummary" mega-tool** — conflicts with single-responsibility;
  the model benefits from composing the three tools independently so it can react
  to each result before proceeding.

## Consequences

- ✅ The harness can ground a multi-month personal-finance session in tool-call
  evidence; every number the agent cites is traceable to an event log entry.
- ✅ N18's seed parameter enables deterministic harness eval runs and replay.
- ✅ Context hydration carries the evolving financial fact graph across sessions
  without re-sending the full transaction history each turn.
- ⚠️ N17 categorisation uses keyword matching; edge cases in merchant names may
  produce "uncategorized" results. A future `MerchantCataloguePort` would resolve this.
- ⚠️ N18 returns rates as model inputs; the harness does not validate them against
  market benchmarks. The LLM should remind the user to consult a financial adviser.
