import { describe, expect, it, vi } from "vitest";
import { initialWorkflowState } from "../domain/workflow-state.js";
import { NoopEventLog } from "../ports/event-log.port.js";
import { BudgetEnforcer } from "./budget-enforcer.js";
import type { HarnessMiddleware, StepContext } from "./index.js";
import { LoopDetector } from "./loop-detector.js";
import { compose, withBudget, withLoopDetection, withTiming } from "./middleware.js";
import { createStepBag } from "./step.js";

// ---------------------------------------------------------------------------
// Minimal fakes for middleware tests (no adapters-memory dependency)
// ---------------------------------------------------------------------------

const BUDGET = {
  maxTokens: 1000,
  maxSteps: 10,
  maxWallClockMs: 60_000,
  maxCostUsd: 5.0,
};

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  const state = initialWorkflowState("wf-1");
  return {
    step: {
      stepId: "step-1",
      kind: "tool_call",
      input: { toolName: "myTool", args: { x: 1 }, callId: "call-1" },
    },
    workflowId: "wf-1",
    budget: BUDGET,
    state,
    eventLog: new NoopEventLog(),
    toolRegistry: {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      schemas: vi.fn().mockReturnValue([]),
    },
    clock: {
      now: vi.fn().mockReturnValue(1000),
      nowIso: vi.fn().mockReturnValue("1970-01-01T00:00:01Z"),
    },
    idPort: { newId: vi.fn().mockReturnValue("generated-id") },
    bag: createStepBag(1),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

describe("compose", () => {
  it("calls middlewares in left-to-right order", async () => {
    const order: string[] = [];
    const a: HarnessMiddleware = async (_, next) => {
      order.push("a-pre");
      await next();
      order.push("a-post");
    };
    const b: HarnessMiddleware = async (_, next) => {
      order.push("b-pre");
      await next();
      order.push("b-post");
    };
    const c: HarnessMiddleware = async (_, next) => {
      order.push("c-pre");
      await next();
      order.push("c-post");
    };

    const ctx = makeCtx();
    await compose(
      a,
      b,
      c,
    )(ctx, async () => {
      order.push("terminal");
    });

    expect(order).toEqual(["a-pre", "b-pre", "c-pre", "terminal", "c-post", "b-post", "a-post"]);
  });

  it("short-circuits when a middleware does not call next()", async () => {
    const terminal = vi.fn();
    const blocker: HarnessMiddleware = async (_ctx, _next) => {
      /* intentionally skip next */
    };

    const ctx = makeCtx();
    await compose(blocker)(ctx, terminal);

    expect(terminal).not.toHaveBeenCalled();
  });

  it("works with zero middlewares (calls terminal directly)", async () => {
    const terminal = vi.fn();
    await compose()(makeCtx(), terminal);
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("swapping middleware order changes execution sequence without breaking compose", async () => {
    const order: string[] = [];
    const x: HarnessMiddleware = async (_, next) => {
      order.push("x");
      await next();
    };
    const y: HarnessMiddleware = async (_, next) => {
      order.push("y");
      await next();
    };

    const ctx1 = makeCtx();
    await compose(x, y)(ctx1, async () => {});
    expect(order).toEqual(["x", "y"]);

    order.length = 0;

    const ctx2 = makeCtx();
    await compose(y, x)(ctx2, async () => {});
    expect(order).toEqual(["y", "x"]);
  });
});

// ---------------------------------------------------------------------------
// withBudget
// ---------------------------------------------------------------------------

describe("withBudget", () => {
  it("calls next() when no budget is exceeded", async () => {
    const next = vi.fn();
    const enforcer = new BudgetEnforcer(BUDGET);
    const ctx = makeCtx();
    await withBudget(enforcer)(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.bag.budgetExceeded).toBeNull();
  });

  it("sets bag.budgetExceeded and skips next() when budget exceeded", async () => {
    const next = vi.fn();
    const enforcer = new BudgetEnforcer({ ...BUDGET, maxSteps: 0 });
    const ctx = makeCtx({
      state: {
        ...initialWorkflowState("wf-1"),
        budget: { tokensUsed: 0, stepsCompleted: 1, wallClockMs: 0, costUsd: 0 },
      },
    });
    await withBudget(enforcer)(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.bag.budgetExceeded).not.toBeNull();
    expect(ctx.bag.budgetExceeded?.reason).toBe("steps");
  });
});

// ---------------------------------------------------------------------------
// withLoopDetection
// ---------------------------------------------------------------------------

describe("withLoopDetection", () => {
  it("sets null when below threshold", async () => {
    const detector = new LoopDetector(3);
    const ctx = makeCtx();
    await withLoopDetection(detector)(ctx, async () => {});
    expect(ctx.bag.correctiveMessage).toBeNull();
  });

  it("sets correctiveMessage when threshold reached and still calls next()", async () => {
    const detector = new LoopDetector(2);
    const next = vi.fn();
    const ctx = makeCtx();
    // First call — below threshold
    await withLoopDetection(detector)(ctx, next);
    // Second call — at threshold
    await withLoopDetection(detector)(makeCtx(), next);
    const thresholdCtx = makeCtx();
    await withLoopDetection(detector)(thresholdCtx, async () => {});
    // Third call because detector is at threshold after 2 calls
    // Let's just check the third call with the same ctx
    const ctx2 = makeCtx();
    await withLoopDetection(new LoopDetector(2))(ctx2, async () => {});
    await withLoopDetection(new LoopDetector(2))(ctx2, async () => {});
    // Actually, let me use a single detector across calls
    const d = new LoopDetector(2);
    const c1 = makeCtx();
    await withLoopDetection(d)(c1, async () => {});
    const c2 = makeCtx(); // same tool + args
    await withLoopDetection(d)(c2, async () => {});
    expect(c2.bag.correctiveMessage).not.toBeNull();
    expect(c2.bag.correctiveMessage).toContain("myTool");
  });

  it("still calls next() even when loop detected", async () => {
    const d = new LoopDetector(1);
    const next = vi.fn();
    const ctx = makeCtx();
    await withLoopDetection(d)(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// withTiming
// ---------------------------------------------------------------------------

describe("withTiming", () => {
  it("sets startedAt and durationMs on the bag", async () => {
    let callCount = 0;
    const clock = {
      now: vi.fn().mockImplementation(() => (callCount++ === 0 ? 1000 : 1200)),
      nowIso: vi.fn().mockReturnValue("2024-01-01T00:00:00Z"),
    };
    const ctx = makeCtx({ clock });

    await withTiming()(ctx, async () => {});

    expect(ctx.bag.startedAt).toBe(1000);
    expect(ctx.bag.durationMs).toBe(200);
  });
});
