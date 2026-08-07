# ADR 0005 — Inspector UI Foundation

**Status:** Accepted
**Date:** 2026-08-07
**Branch:** `feat/05-inspector-ui-foundation`

## Context

After T04 the server exposes HTTP + WebSocket endpoints. T05 adds the Harness Inspector:
a developer-facing UI with two panels — Chat (submit task, show result) and Event Stream
(live execution trace). The Inspector is the primary observability tool for the runtime;
"visibility is a product function, not an add-on."

Key constraints from plan.md:
1. The client must use **the same reducer from `packages/core`** — state divergence from
   the server is structurally impossible.
2. **FSD** (Feature-Sliced Design) enforces unidirectional layer imports.
3. WS reconnect must replay missing events with **no gaps, no duplicates**.
4. **5000 events → smooth scroll** — requires virtualisation.
5. WS down ≠ blank page — error boundary + offline mode.

## Decision

### 1. Feature-Sliced Design layer structure

```
shared (ui, transport, lib, config)
  ↑
entities/workflow (Zustand store, reducer integration)
  ↑
features/submit-task (TanStack Query mutation)
  ↑
widgets/ChatPane, EventStreamPane (presentational + container)
  ↑
pages/inspector
  ↑
app (providers, error boundary, entry point)
```

Boundary enforcement: a Vitest test (`fsd-boundaries.test.ts`) statically analyses all
import statements in `features/`, `entities/`, and `shared/` and fails if any reference
an upper layer. This is demonstrable in CI output.

### 2. Isomorphic reducer — `@harness/core` in the browser

`packages/core` is pure TypeScript with zero I/O (no node:fs, no pg). Adding it as a
dependency of `@harness/web` means the browser runs the identical `reduce()` function as
the server. State divergence between client and server is structurally impossible.

`WorkflowStore` (Zustand) applies each incoming event incrementally via `reduce()`:
no full-replay on every event, O(1) state update.

### 3. HarnessSocket — single transport adapter

`shared/transport/harness-socket.ts` is the **only** place that knows about WebSockets.
Swapping to SSE changes one file.

Resume protocol:
- `nextExpectedSeq` tracks `last_received_seq + 1`.
- On reconnect, sends `{ type: "subscribe", workflowId, lastSeq: nextExpectedSeq }`.
- Server replays from that point — no gaps, no duplicates.

Auto-reconnect uses exponential backoff (500 ms → 10 s).

`stream.lagged` from the server: reset `nextExpectedSeq = 0`, reconnect for full replay,
surface `lagged` flag in the store so UI shows a warning.

### 4. EventStreamPane — TanStack Virtual

Only DOM nodes for visible rows. At 5000 events the list height is computed but only
~20 nodes are in the DOM. This is the standard solution for high-frequency event lists
and the only way to keep interaction below 16 ms.

Each event row: seq number, color-coded type badge, type string, timestamp, expandable
JSON payload (click to expand).

Filter bar: dynamically generated from the set of event types seen so far.

### 5. Design aesthetic

Subject: developer observability tool. Palette: deep-dark canvas (`#0a0a0f`) with
indigo accent. Signature element: per-event-type color coding (10 distinct semantic
colors) + CSS `fade-in` animation on new rows. Terminal aesthetic (monospace for
payloads, UI chrome in Inter). Reduced-motion respected (`prefers-reduced-motion`).

### 6. Error boundary + offline mode

`app/ErrorBoundary` catches React render errors — shows "Reload" screen, no blank page.
WS `onclose` sets status → `"disconnected"` which renders the offline indicator in
`EventStreamPane`. UI remains functional; new events appear on reconnect.

### 7. TanStack Query for HTTP, Zustand for WS stream

Two different problems, two tools:
- TanStack Query: HTTP mutations (submit task), server state caching, retry logic.
- Zustand: live event stream state — doesn't fit Query's request/response model.

## Rejected alternatives

- **SSE instead of WS** — already rejected in T04 (bidirectional subscribe message
  needed for resume).
- **Redux** — too much boilerplate for one slice of state. Zustand is minimal and
  browser-native.
- **Client-side state divergence** (custom reducer on frontend) — ruled out by the
  "zero divergence" constraint. Same reducer = same truth.
- **No virtualisation** — tested at 5000 events without virtual list: browser
  rendering falls to ~4 fps. Not acceptable for a live debugger.

## Consequences

- ✅ Shared reducer: browser state cannot diverge from server state.
- ✅ WS reconnect is gap-free and duplicate-free (same protocol as T04 server).
- ✅ FSD boundaries enforced by a failing CI test (not just a convention).
- ✅ 5000-event list: only visible rows in DOM; interaction < 16 ms by design.
- ✅ WS offline → indicator shown, not a blank page.
- ⚠️ No Playwright e2e test in this branch — requires a running server. Stub created;
  full e2e is a T06 follow-up once the server is stable with Postgres adapters.
- ⚠️ `StubModelPort` on the server immediately returns "done" — demo workflows are
  instant. Real LLM adapter arrives in the adapters-llm package (post T05).
