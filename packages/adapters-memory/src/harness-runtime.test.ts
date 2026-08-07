import type { ToolDefinition } from "@harness/contracts";
import type { TaskPacket } from "@harness/contracts";
import { type HarnessMiddleware, HarnessRuntime, type StepContext } from "@harness/core";
import { err, ok } from "@harness/core";
import type { ToolExecutor } from "@harness/core";
import { describe, expect, it } from "vitest";
import { FakeModelPort } from "./fake-model-port.js";
import { FixedClock } from "./fixed-clock.js";
import { InMemoryEventLog } from "./in-memory-event-log.js";
import { InMemoryStateStore } from "./in-memory-state-store.js";
import { InMemoryToolRegistry } from "./in-memory-tool-registry.js";
import { SeededIdPort } from "./seeded-id-port.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TOOL_DEF: ToolDefinition = {
  name: "echo",
  description: "Echoes the input back",
  dangerous: false,
  idempotent: true,
  costHint: "free",
  inputSchema: { type: "object", properties: { message: { type: "string" } } },
  outputSchema: { type: "object" },
};

function makeEchoTool(overrides?: Partial<ToolExecutor>): ToolExecutor {
  return {
    definition: TOOL_DEF,
    execute: async (args) => ok({ echoed: (args as { message?: string }).message ?? "" }),
    ...overrides,
  };
}

function makeTask(overrides?: Partial<TaskPacket>): TaskPacket {
  return {
    id: "task-1",
    goal: "Test goal",
    budget: {
      maxTokens: 10_000,
      maxSteps: 50,
      maxWallClockMs: 60_000,
      maxCostUsd: 10.0,
    },
    ...overrides,
  };
}

interface TestDeps {
  model: FakeModelPort;
  eventLog: InMemoryEventLog;
  stateStore: InMemoryStateStore;
  toolRegistry: InMemoryToolRegistry;
  clock: FixedClock;
  idPort: SeededIdPort;
  middleware: readonly HarnessMiddleware[];
}

function makeDeps(model: FakeModelPort, registry?: InMemoryToolRegistry): TestDeps {
  return {
    model,
    eventLog: new InMemoryEventLog(),
    stateStore: new InMemoryStateStore(),
    toolRegistry: registry ?? new InMemoryToolRegistry(),
    clock: new FixedClock(0),
    idPort: new SeededIdPort(),
    middleware: [],
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("HarnessRuntime — happy path", () => {
  it("completes a workflow that needs no tool calls", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("Done!")]);
    const deps = makeDeps(model);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(makeTask());

    expect(state.status).toBe("completed");
  });

  it("completes a workflow with one tool call then a final answer", async () => {
    const model = new FakeModelPort([
      FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: { message: "hello" } }]),
      FakeModelPort.textResponse("All done"),
    ]);
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(makeTask());

    expect(state.status).toBe("completed");
    const types = deps.eventLog.all().map((e) => e.type);
    expect(types).toContain("workflow.started");
    expect(types).toContain("step.planned");
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.succeeded");
    expect(types).toContain("state.checkpointed");
    expect(types).toContain("workflow.completed");
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement — each of the four budgets independently halts the run
// ---------------------------------------------------------------------------

describe("HarnessRuntime — budget enforcement", () => {
  it("halts with status 'halted' when steps budget is exceeded", async () => {
    const model = FakeModelPort.infiniteLoop("echo", { message: "hi" });
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(
      makeTask({
        budget: { maxTokens: 99999, maxSteps: 2, maxWallClockMs: 9_999_999, maxCostUsd: 9999 },
      }),
    );

    expect(state.status).toBe("halted");
    const failedEvent = deps.eventLog.all().find((e) => e.type === "workflow.failed");
    expect(failedEvent).toBeDefined();
    if (failedEvent?.type === "workflow.failed") {
      expect(failedEvent.payload.budgetExceeded?.reason).toBe("steps");
    }
  });

  it("halts when token budget is exceeded", async () => {
    // Each model response uses 150 tokens (FakeModelPort default); maxTokens=100 → exceeded after first turn
    const model = FakeModelPort.infiniteLoop("echo", {});
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(
      makeTask({
        budget: { maxTokens: 100, maxSteps: 9999, maxWallClockMs: 9_999_999, maxCostUsd: 9999 },
      }),
    );

    expect(state.status).toBe("halted");
    const failedEvent = deps.eventLog.all().find((e) => e.type === "workflow.failed");
    if (failedEvent?.type === "workflow.failed") {
      expect(failedEvent.payload.budgetExceeded?.reason).toBe("tokens");
    }
  });

  it("halts when wallClock budget is exceeded", async () => {
    // FixedClock at 0ms; maxWallClockMs=0 → 0ms elapsed >= 0ms limit → triggers immediately
    const model = FakeModelPort.infiniteLoop("echo", {});
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(
      makeTask({
        budget: { maxTokens: 9999, maxSteps: 9999, maxWallClockMs: 0, maxCostUsd: 9999 },
      }),
    );

    expect(state.status).toBe("halted");
    const failedEvent = deps.eventLog.all().find((e) => e.type === "workflow.failed");
    if (failedEvent?.type === "workflow.failed") {
      expect(failedEvent.payload.budgetExceeded?.reason).toBe("wallClock");
    }
  });

  it("halts when costUsd budget is exceeded", async () => {
    // costUsd starts at 0; maxCostUsd=0 → 0 >= 0 → triggers immediately
    const model = FakeModelPort.infiniteLoop("echo", {});
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(
      makeTask({
        budget: { maxTokens: 9999, maxSteps: 9999, maxWallClockMs: 9_999_999, maxCostUsd: 0 },
      }),
    );

    expect(state.status).toBe("halted");
    const failedEvent = deps.eventLog.all().find((e) => e.type === "workflow.failed");
    if (failedEvent?.type === "workflow.failed") {
      expect(failedEvent.payload.budgetExceeded?.reason).toBe("costUsd");
    }
  });
});

// ---------------------------------------------------------------------------
// Loop detection — corrective message injected, loop continues
// ---------------------------------------------------------------------------

describe("HarnessRuntime — loop detection", () => {
  it("injects a corrective message after 3 identical tool calls and continues to completion", async () => {
    const model = new FakeModelPort([
      FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: { x: 1 } }]),
      FakeModelPort.toolCallResponse([{ id: "c2", name: "echo", args: { x: 1 } }]),
      FakeModelPort.toolCallResponse([{ id: "c3", name: "echo", args: { x: 1 } }]),
      FakeModelPort.textResponse("I understand, I will stop repeating the call."),
    ]);
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    const state = await runtime.run(makeTask());

    // Runtime should complete (not halt) — loop detection is advisory
    expect(state.status).toBe("completed");

    // The 4th model call should include a user message containing the corrective prompt
    const fourthCtx = model.capturedCalls[3];
    expect(fourthCtx).toBeDefined();
    const userMessages = fourthCtx?.messages.filter((m) => m.role === "user") ?? [];
    const hasCorrectiveMsg = userMessages.some(
      (m) => typeof m.content === "string" && m.content.includes("[HARNESS]"),
    );
    expect(hasCorrectiveMsg).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool errors — returned as data (ok:false), not as exceptions
// ---------------------------------------------------------------------------

describe("HarnessRuntime — tool error handling", () => {
  it("returns tool error as ok:false in the tool message and continues the workflow", async () => {
    const failingTool: ToolExecutor = {
      definition: TOOL_DEF,
      execute: async () =>
        err({ code: "COMPUTE_ERROR", message: "Division by zero", retryable: false }),
    };

    const model = new FakeModelPort([
      FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: {} }]),
      FakeModelPort.textResponse("I see the tool failed, providing answer from knowledge."),
    ]);
    const registry = new InMemoryToolRegistry();
    registry.register(failingTool);
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    // Must NOT throw — tool errors are values, not exceptions
    const state = await runtime.run(makeTask());

    expect(state.status).toBe("completed");

    // The second model call should have received a tool message with ok:false
    const secondCtx = model.capturedCalls[1];
    const toolMsg = secondCtx?.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg?.content ?? "{}") as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("COMPUTE_ERROR");
  });

  it("emits a tool.failed event instead of throwing", async () => {
    const failingTool: ToolExecutor = {
      definition: TOOL_DEF,
      execute: async () => err({ code: "FAIL", message: "fail", retryable: false }),
    };
    const model = new FakeModelPort([
      FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: {} }]),
      FakeModelPort.textResponse("done"),
    ]);
    const registry = new InMemoryToolRegistry();
    registry.register(failingTool);
    const deps = makeDeps(model, registry);
    const runtime = new HarnessRuntime(deps);

    await runtime.run(makeTask());

    const events = deps.eventLog.all();
    expect(events.some((e) => e.type === "tool.failed")).toBe(true);
    expect(events.some((e) => e.type === "workflow.completed")).toBe(true);
    // No exception was thrown — verified by reaching this assertion
  });
});

// ---------------------------------------------------------------------------
// Determinism — same input + FixedClock + SeededIdPort → identical event seq
// ---------------------------------------------------------------------------

describe("HarnessRuntime — determinism", () => {
  function buildDeterministicDeps(model: FakeModelPort): TestDeps {
    const registry = new InMemoryToolRegistry();
    registry.register(makeEchoTool());
    return {
      model,
      eventLog: new InMemoryEventLog(),
      stateStore: new InMemoryStateStore(),
      toolRegistry: registry,
      clock: new FixedClock(1_000_000),
      idPort: new SeededIdPort("det"),
      middleware: [],
    };
  }

  it("produces identical event sequences on two runs with the same seeds", async () => {
    const task = makeTask({ id: "det-task", goal: "deterministic test" });

    const run = async () => {
      const model = new FakeModelPort([
        FakeModelPort.toolCallResponse([{ id: "call-x", name: "echo", args: { v: 42 } }]),
        FakeModelPort.textResponse("deterministic answer"),
      ]);
      const deps = buildDeterministicDeps(model);
      const runtime = new HarnessRuntime(deps);
      await runtime.run(task);
      return deps.eventLog.all();
    };

    const events1 = await run();
    const events2 = await run();

    expect(events1).toEqual(events2);
  });
});

// ---------------------------------------------------------------------------
// Middleware composability — order swap does not break the runtime
// ---------------------------------------------------------------------------

describe("HarnessRuntime — middleware composability", () => {
  it("middleware can be reordered without breaking the runtime", async () => {
    const order: string[] = [];

    const mwA: HarnessMiddleware = async (_ctx: StepContext, next) => {
      order.push("A-pre");
      await next();
      order.push("A-post");
    };
    const mwB: HarnessMiddleware = async (_ctx: StepContext, next) => {
      order.push("B-pre");
      await next();
      order.push("B-post");
    };

    const makeRun = async (mws: HarnessMiddleware[]) => {
      order.length = 0;
      const model = new FakeModelPort([
        FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: {} }]),
        FakeModelPort.textResponse("done"),
      ]);
      const registry = new InMemoryToolRegistry();
      registry.register(makeEchoTool());
      const runtime = new HarnessRuntime({
        model,
        eventLog: new InMemoryEventLog(),
        stateStore: new InMemoryStateStore(),
        toolRegistry: registry,
        clock: new FixedClock(0),
        idPort: new SeededIdPort(),
        middleware: mws,
      });
      return runtime.run(makeTask());
    };

    // [A, B] — A wraps B
    const state1 = await makeRun([mwA, mwB]);
    expect(state1.status).toBe("completed");
    const orderAB = [...order];
    expect(orderAB.indexOf("A-pre")).toBeLessThan(orderAB.indexOf("B-pre"));

    // [B, A] — B wraps A
    const state2 = await makeRun([mwB, mwA]);
    expect(state2.status).toBe("completed");
    const orderBA = [...order];
    expect(orderBA.indexOf("B-pre")).toBeLessThan(orderBA.indexOf("A-pre"));
  });
});
