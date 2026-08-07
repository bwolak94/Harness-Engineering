import type { HarnessEvent } from "@harness/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce, rehydrate } from "./reducer.js";
import { initialWorkflowState } from "./workflow-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKFLOW_ID = "wf-test-001";

function base(seq: number, type: string): Record<string, unknown> {
  return {
    id: `evt-${seq}`,
    workflowId: WORKFLOW_ID,
    seq,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    type,
  };
}

const startedEvent = (seq = 0): HarnessEvent =>
  ({
    ...base(seq, "workflow.started"),
    payload: {
      task: {
        id: "task-1",
        goal: "test goal",
        budget: {
          maxTokens: 10000,
          maxSteps: 10,
          maxWallClockMs: 60000,
          maxCostUsd: 1.0,
        },
      },
    },
  }) as HarnessEvent;

const stepPlannedEvent = (seq: number, stepId: string): HarnessEvent =>
  ({
    ...base(seq, "step.planned"),
    payload: { stepId, kind: "tool_call", input: { tool: "analyzeInvestment" } },
  }) as HarnessEvent;

const toolCalledEvent = (seq: number, stepId: string, callId = "call-1"): HarnessEvent =>
  ({
    ...base(seq, "tool.called"),
    payload: { stepId, toolName: "analyzeInvestment", args: {}, callId },
  }) as HarnessEvent;

const toolSucceededEvent = (seq: number, stepId: string, callId = "call-1"): HarnessEvent =>
  ({
    ...base(seq, "tool.succeeded"),
    payload: { stepId, callId, result: { irr: 0.12 }, durationMs: 50 },
  }) as HarnessEvent;

const toolFailedEvent = (seq: number, stepId: string): HarnessEvent =>
  ({
    ...base(seq, "tool.failed"),
    payload: {
      stepId,
      callId: "call-x",
      code: "TIMEOUT",
      message: "tool timed out",
      retryable: true,
    },
  }) as HarnessEvent;

const checkpointedEvent = (seq: number): HarnessEvent =>
  ({
    ...base(seq, "state.checkpointed"),
    payload: {
      checkpointId: "ckpt-1",
      tokensUsed: 500,
      stepsCompleted: 1,
      costUsd: 0.01,
    },
  }) as HarnessEvent;

const suspendedEvent = (seq: number): HarnessEvent =>
  ({
    ...base(seq, "workflow.suspended"),
    payload: { reason: "awaiting approval", resumeToken: "tok-abc" },
  }) as HarnessEvent;

const resumedEvent = (seq: number): HarnessEvent =>
  ({
    ...base(seq, "workflow.resumed"),
    payload: { resumeToken: "tok-abc", input: { approved: true } },
  }) as HarnessEvent;

const completedEvent = (seq: number): HarnessEvent =>
  ({
    ...base(seq, "workflow.completed"),
    payload: {
      result: { answer: 42 },
      tokensUsed: 1000,
      stepsCompleted: 3,
      totalCostUsd: 0.05,
      durationMs: 2000,
    },
  }) as HarnessEvent;

const failedEvent = (seq: number, withBudget = false): HarnessEvent =>
  ({
    ...base(seq, "workflow.failed"),
    payload: {
      code: "BUDGET_EXCEEDED",
      message: "too many steps",
      ...(withBudget ? { budgetExceeded: { reason: "steps", limit: 10, actual: 11 } } : {}),
    },
  }) as HarnessEvent;

const INITIAL = () => initialWorkflowState(WORKFLOW_ID);

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("reducer — workflow.started", () => {
  it("transitions status to running", () => {
    const state = reduce(INITIAL(), startedEvent(0));
    expect(state.status).toBe("running");
    expect(state.seq).toBe(0);
  });
});

describe("reducer — step.planned", () => {
  it("appends a pending step", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, stepPlannedEvent(1, "s1"));
    expect(state.pendingSteps).toHaveLength(1);
    expect(state.pendingSteps[0]?.stepId).toBe("s1");
    expect(state.seq).toBe(1);
  });

  it("accumulates multiple steps", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, stepPlannedEvent(1, "s1"));
    state = reduce(state, stepPlannedEvent(2, "s2"));
    expect(state.pendingSteps).toHaveLength(2);
  });
});

describe("reducer — tool.called", () => {
  it("advances seq without changing other fields", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, stepPlannedEvent(1, "s1"));
    const before = state.pendingSteps.length;
    state = reduce(state, toolCalledEvent(2, "s1"));
    expect(state.seq).toBe(2);
    expect(state.pendingSteps.length).toBe(before);
  });
});

describe("reducer — tool.succeeded", () => {
  it("removes the step and increments stepsCompleted", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, stepPlannedEvent(1, "s1"));
    state = reduce(state, toolCalledEvent(2, "s1"));
    state = reduce(state, toolSucceededEvent(3, "s1"));
    expect(state.pendingSteps).toHaveLength(0);
    expect(state.budget.stepsCompleted).toBe(1);
    expect(state.budget.wallClockMs).toBe(50);
  });
});

describe("reducer — tool.failed", () => {
  it("removes the pending step", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, stepPlannedEvent(1, "s1"));
    state = reduce(state, toolFailedEvent(2, "s1"));
    expect(state.pendingSteps).toHaveLength(0);
    expect(state.status).toBe("running");
  });
});

describe("reducer — state.checkpointed", () => {
  it("updates budget from checkpoint payload", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, checkpointedEvent(1));
    expect(state.budget.tokensUsed).toBe(500);
    expect(state.budget.stepsCompleted).toBe(1);
    expect(state.budget.costUsd).toBe(0.01);
  });
});

describe("reducer — workflow.suspended", () => {
  it("sets status to suspended and stores resumeToken", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, suspendedEvent(1));
    expect(state.status).toBe("suspended");
    expect(state.resumeToken).toBe("tok-abc");
    expect(state.suspendedAt).toBeDefined();
  });
});

describe("reducer — workflow.resumed", () => {
  it("restores running status and clears suspension fields", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, suspendedEvent(1));
    state = reduce(state, resumedEvent(2));
    expect(state.status).toBe("running");
    expect(state.resumeToken).toBeUndefined();
    expect(state.suspendedAt).toBeUndefined();
  });
});

describe("reducer — workflow.completed", () => {
  it("transitions to completed and stores result", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, completedEvent(1));
    expect(state.status).toBe("completed");
    expect(state.completedAt).toBeDefined();
    expect(state.result).toEqual({ answer: 42 });
    expect(state.budget.tokensUsed).toBe(1000);
  });
});

describe("reducer — workflow.failed (no budget)", () => {
  it("transitions to failed", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, failedEvent(1, false));
    expect(state.status).toBe("failed");
    expect(state.failedAt).toBeDefined();
    expect(state.error).toBe("too many steps");
  });
});

describe("reducer — workflow.failed (budget exceeded)", () => {
  it("transitions to halted when budgetExceeded is present", () => {
    let state = reduce(INITIAL(), startedEvent(0));
    state = reduce(state, failedEvent(1, true));
    expect(state.status).toBe("halted");
  });
});

describe("rehydrate", () => {
  it("replays events and produces correct final state", () => {
    const events: HarnessEvent[] = [
      startedEvent(0),
      stepPlannedEvent(1, "s1"),
      toolCalledEvent(2, "s1"),
      toolSucceededEvent(3, "s1"),
      checkpointedEvent(4),
    ];
    const state = rehydrate(WORKFLOW_ID, events, INITIAL());
    expect(state.status).toBe("running");
    expect(state.seq).toBe(4);
    expect(state.budget.stepsCompleted).toBe(1);
    expect(state.budget.tokensUsed).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (fast-check)
// ---------------------------------------------------------------------------

describe("property: reducer never throws", () => {
  /**
   * For any sequence of valid HarnessEvents, the reducer must never throw.
   * This guards against gaps in the exhaustive switch.
   */
  const anyEvent = fc.oneof(
    fc.constant(startedEvent(0)),
    fc.integer({ min: 0, max: 100 }).map((n) => stepPlannedEvent(n, `step-${n}`)),
    fc.integer({ min: 0, max: 100 }).map((n) => toolCalledEvent(n, `step-${n}`)),
    fc.integer({ min: 0, max: 100 }).map((n) => toolSucceededEvent(n, `step-${n}`)),
    fc.integer({ min: 0, max: 100 }).map((n) => toolFailedEvent(n, `step-${n}`)),
    fc.integer({ min: 0, max: 100 }).map((n) => checkpointedEvent(n)),
    fc.integer({ min: 0, max: 100 }).map((n) => suspendedEvent(n)),
    fc.integer({ min: 0, max: 100 }).map((n) => resumedEvent(n)),
    fc.integer({ min: 0, max: 100 }).map((n) => completedEvent(n)),
    fc.boolean().map((b) => failedEvent(0, b)),
  );

  it("never throws for any valid event", () => {
    fc.assert(
      fc.property(anyEvent, (event) => {
        expect(() => reduce(INITIAL(), event)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("property: seq never decreases across a sequence", () => {
  /**
   * For any sequence of events applied in ascending seq order, the resulting
   * state.seq must equal the last event's seq (never goes backwards).
   */
  const orderedEvents = fc
    .array(fc.nat(200), { minLength: 1, maxLength: 20 })
    .map((seqs) =>
      [...new Set(seqs)].sort((a, b) => a - b).map((seq) => stepPlannedEvent(seq, `step-${seq}`)),
    );

  it("state.seq equals the last applied event seq", () => {
    fc.assert(
      fc.property(orderedEvents, (events) => {
        const final = rehydrate(WORKFLOW_ID, events, INITIAL());
        const lastSeq = events.at(-1)?.seq ?? -1;
        expect(final.seq).toBe(lastSeq);
      }),
      { numRuns: 300 },
    );
  });

  it("seq never decreases step by step", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(200), { minLength: 2, maxLength: 15 }), (seqs) => {
        const sorted = [...new Set(seqs)].sort((a, b) => a - b);
        if (sorted.length < 2) return;
        let state = INITIAL();
        let prevSeq = -1;
        for (const seq of sorted) {
          state = reduce(state, stepPlannedEvent(seq, `s-${seq}`));
          expect(state.seq).toBeGreaterThanOrEqual(prevSeq);
          prevSeq = state.seq;
        }
      }),
      { numRuns: 300 },
    );
  });
});
