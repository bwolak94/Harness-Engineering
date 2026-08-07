# ADR 0000 — Record Architecture Decisions

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** Project team
**Task:** T00

## Context

We need to document significant architectural decisions made during the development of Harness Lab so that:
- Future contributors understand the reasoning behind choices, not just the choices themselves.
- We can revisit and challenge assumptions when the context changes.
- Trade-offs between rejected alternatives are explicit.

Without a lightweight decision-recording process, knowledge lives only in the heads of early contributors.

## Decision

We will use Architecture Decision Records (ADRs) in the [MADR](https://adr.github.io/madr/) format, stored in `docs/adr/`.

One ADR per task (minimum). Every significant technology choice, structural change, or rejected alternative requires an ADR entry before implementation begins.

File naming: `NNNN-kebab-case-title.md` where `NNNN` is the zero-padded task ID.

## Consequences

- Every PR touching architecture must include or reference an ADR.
- ADRs are immutable once "Accepted" — superseded ADRs get a new record that references the old one.
- The `architect` agent is the only agent authorised to create and accept ADRs.

## Rejected alternatives

- **Wiki pages** — not co-located with code, diverge from reality over time.
- **PR descriptions alone** — not searchable, disappear from developer workflow after merge.
- **Inline comments** — lose the "why rejected" alternatives that are the most valuable part.

---

## ADR Template

Copy the template below for each new decision:

```markdown
# ADR NNNN — Title

**Date:** YYYY-MM-DD
**Status:** Draft | Accepted | Superseded by MMMM
**Deciders:** [names or agent roles]
**Task:** T??

## Context

[Why is this decision needed? What forces are at play?]

## Decision

[What was decided?]

## Consequences

[What becomes easier or harder as a result?]

## Rejected alternatives

[What else was considered and why was it ruled out?]
```
