import type { Budget, HarnessEvent } from "@harness/contracts";
import { type FlowSpec, NoopCanaryStore, ShadowRunner, Supervisor } from "@harness/core";
import { describe, expect, it, vi } from "vitest";
import {
  FakeModelPort,
  FixedClock,
  InMemoryAgentRegistry,
  InMemoryCanaryStore,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryToolRegistry,
  SeededIdPort,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_BUDGET: Budget = {
  maxTokens: 10_000,
  maxSteps: 20,
  maxWallClockMs: 60_000,
  maxCostUsd: 1.0,
};

/** Minimal agent registry with a single "test-agent". */
function makeAgentRegistry(): InMemoryAgentRegistry {
  return new InMemoryAgentRegistry([
    {
      name: "test-agent",
      description: "A test agent",
      toolNames: ["stubTool"],
    },
  ]);
}

/** Tool registry with a single stub tool. */
function makeToolRegistry(): InMemoryToolRegistry {
  const reg = new InMemoryToolRegistry();
  reg.register({
    definition: {
      name: "stubTool",
      description: "stub",
      dangerous: false,
      idempotent: true,
      costHint: "free",
      inputSchema: {},
      outputSchema: {},
    },
    execute: async () => ({ ok: true, value: { done: true } }),
  });
  return reg;
}

/** FlowSpec that uses "test-agent" for a single step. */
const BASELINE_SPEC: FlowSpec = {
  id: "baseline-flow",
  name: "Baseline Flow",
  description: "Production baseline",
  pattern: "sequential",
  steps: [{ agentName: "test-agent", goalTemplate: "{{goal}}" }],
};

const CANARY_SPEC: FlowSpec = {
  id: "canary-flow",
  name: "Canary Flow",
  description: "Canary variant",
  version: "v2",
  pattern: "sequential",
  steps: [{ agentName: "test-agent", goalTemplate: "{{goal}}" }],
  canary: {
    trafficPct: 100, // always shadow
    maxCostDeltaPct: 20,
    maxTokenDeltaPct: 20,
    maxDurationDeltaPct: 50,
  },
};

function makeShadowDeps(responseCount: number, clock?: FixedClock) {
  // ShadowRunner uses TWO FlowRunners (baseline + canary), each running one step.
  // With sequential single-step flows: baseline uses 1 response, canary uses 1 response.
  const responses = Array.from({ length: responseCount }, () =>
    FakeModelPort.textResponse("Done."),
  );
  const model = new FakeModelPort(responses);
  const agentRegistry = makeAgentRegistry();

  return {
    agentRegistry,
    toolRegistry: makeToolRegistry(),
    supervisor: new Supervisor(5),
    model,
    eventLog: new InMemoryEventLog(),
    stateStore: new InMemoryStateStore(),
    clock: clock ?? new FixedClock(Date.now()),
    idPort: new SeededIdPort(),
    middleware: [],
  };
}

/** Wait for background shadow run to settle (fire-and-forget needs a tick). */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// FlowSpec extensions — canary config fields
// ---------------------------------------------------------------------------

describe("FlowSpec — canary config", () => {
  it("accepts version and canary fields", () => {
    const spec: FlowSpec = {
      ...BASELINE_SPEC,
      version: "1.0.0",
      canary: { trafficPct: 50 },
    };
    expect(spec.version).toBe("1.0.0");
    expect(spec.canary?.trafficPct).toBe(50);
  });

  it("remains valid without optional fields", () => {
    const spec: FlowSpec = {
      id: "minimal",
      name: "Minimal",
      description: "minimal",
      pattern: "sequential",
      steps: [],
    };
    expect(spec.version).toBeUndefined();
    expect(spec.canary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NoopCanaryStore
// ---------------------------------------------------------------------------

describe("NoopCanaryStore", () => {
  it("save() resolves without storing anything", async () => {
    const store = new NoopCanaryStore();
    await expect(
      store.save({
        id: "r1",
        baselineFlowId: "f1",
        canaryFlowId: "f2",
        canaryVersion: "v1",
        goal: "test",
        at: new Date().toISOString(),
        baseline: { stepCount: 1, tokensUsed: 100, costUsd: 0.01, durationMs: 500, partial: false },
        canary: { stepCount: 1, tokensUsed: 100, costUsd: 0.01, durationMs: 500, partial: false },
      }),
    ).resolves.toBeUndefined();
  });

  it("list() always returns empty array", async () => {
    const store = new NoopCanaryStore();
    expect(await store.list("any-flow")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// InMemoryCanaryStore
// ---------------------------------------------------------------------------

describe("InMemoryCanaryStore", () => {
  const sampleRecord = (id: string, baselineFlowId: string) => ({
    id,
    baselineFlowId,
    canaryFlowId: "canary",
    canaryVersion: "v1",
    goal: "test goal",
    at: new Date().toISOString(),
    baseline: { stepCount: 2, tokensUsed: 100, costUsd: 0.01, durationMs: 500, partial: false },
    canary: { stepCount: 2, tokensUsed: 110, costUsd: 0.011, durationMs: 550, partial: false },
  });

  it("stores and retrieves records for the correct flow", async () => {
    const store = new InMemoryCanaryStore();
    await store.save(sampleRecord("r1", "flow-a"));
    await store.save(sampleRecord("r2", "flow-b"));

    const resultsA = await store.list("flow-a");
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]?.id).toBe("r1");
  });

  it("list() returns newest-first", async () => {
    const store = new InMemoryCanaryStore();
    await store.save(sampleRecord("old", "flow-a"));
    await store.save(sampleRecord("new", "flow-a"));

    const results = await store.list("flow-a");
    expect(results[0]?.id).toBe("new");
    expect(results[1]?.id).toBe("old");
  });

  it("list() respects the limit parameter", async () => {
    const store = new InMemoryCanaryStore();
    for (let i = 0; i < 5; i++) {
      await store.save(sampleRecord(`r${i}`, "flow-a"));
    }
    const results = await store.list("flow-a", 3);
    expect(results).toHaveLength(3);
  });

  it("size() reflects total records across all flows", async () => {
    const store = new InMemoryCanaryStore();
    await store.save(sampleRecord("r1", "flow-a"));
    await store.save(sampleRecord("r2", "flow-b"));
    expect(store.size()).toBe(2);
  });

  it("clear() removes all records", async () => {
    const store = new InMemoryCanaryStore();
    await store.save(sampleRecord("r1", "flow-a"));
    store.clear();
    expect(store.size()).toBe(0);
    expect(await store.list("flow-a")).toHaveLength(0);
  });

  it("all() returns records in insertion order", async () => {
    const store = new InMemoryCanaryStore();
    await store.save(sampleRecord("first", "flow-a"));
    await store.save(sampleRecord("second", "flow-a"));
    const all = store.all();
    expect(all[0]?.id).toBe("first");
    expect(all[1]?.id).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// ShadowRunner
// ---------------------------------------------------------------------------

describe("ShadowRunner", () => {
  it("returns the baseline result (not the canary result)", async () => {
    const deps = makeShadowDeps(2);
    const store = new InMemoryCanaryStore();
    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: store,
    });

    const result = await runner.run(BASELINE_SPEC, "test goal", TEST_BUDGET);

    // Must return baseline result
    expect(result.flowId).toBe(BASELINE_SPEC.id);
    expect(result.steps).toHaveLength(1);
  });

  it("fires a background shadow run and saves a canary record", async () => {
    const deps = makeShadowDeps(2);
    const store = new InMemoryCanaryStore();
    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: store,
    });

    await runner.run(BASELINE_SPEC, "test goal", TEST_BUDGET);
    // Allow background task to complete
    await tick();
    await tick();

    expect(store.size()).toBe(1);
    const [record] = store.all();
    expect(record?.baselineFlowId).toBe(BASELINE_SPEC.id);
    expect(record?.canaryFlowId).toBe(CANARY_SPEC.id);
    expect(record?.canaryVersion).toBe("v2");
    expect(record?.goal).toBe("test goal");
  });

  it("emits canary.started and canary.completed events", async () => {
    const deps = makeShadowDeps(2);
    const store = new InMemoryCanaryStore();
    const events: HarnessEvent[] = [];

    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: store,
      onEvent: (e) => events.push(e),
    });

    await runner.run(BASELINE_SPEC, "test goal", TEST_BUDGET);
    await tick();
    await tick();

    const types = events.map((e) => e.type);
    expect(types).toContain("canary.started");
    expect(types).toContain("canary.completed");
  });

  it("does not emit canary.regression when there is no divergence", async () => {
    const deps = makeShadowDeps(2);
    const store = new InMemoryCanaryStore();
    const events: HarnessEvent[] = [];

    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: store,
      onEvent: (e) => events.push(e),
    });

    await runner.run(BASELINE_SPEC, "test goal", TEST_BUDGET);
    await tick();
    await tick();

    const regressionEvents = events.filter((e) => e.type === "canary.regression");
    // With FakeModel producing identical responses, divergence should be 0.
    expect(regressionEvents).toHaveLength(0);
  });

  it("does not fire shadow run when trafficPct is 0", async () => {
    const deps = makeShadowDeps(1);
    const store = new InMemoryCanaryStore();

    const zeroTrafficSpec: FlowSpec = {
      ...CANARY_SPEC,
      canary: { trafficPct: 0 },
    };

    const runner = new ShadowRunner(deps, {
      canarySpec: zeroTrafficSpec,
      canaryStore: store,
    });

    await runner.run(BASELINE_SPEC, "test goal", TEST_BUDGET);
    await tick();

    expect(store.size()).toBe(0);
  });

  it("does not fire shadow run when trafficPct is 100 but signal is aborted", async () => {
    const deps = makeShadowDeps(1);
    const store = new InMemoryCanaryStore();

    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: store,
    });

    const controller = new AbortController();
    controller.abort();

    await runner.run(BASELINE_SPEC, "test goal", TEST_BUDGET, controller.signal);
    await tick();

    // Signal already aborted → shadow suppressed
    expect(store.size()).toBe(0);
  });

  it("canary.started payload contains correct metadata", async () => {
    const deps = makeShadowDeps(2);
    const store = new InMemoryCanaryStore();
    const events: HarnessEvent[] = [];

    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: store,
      onEvent: (e) => events.push(e),
    });

    await runner.run(BASELINE_SPEC, "my goal", TEST_BUDGET);
    await tick();
    await tick();

    const started = events.find((e) => e.type === "canary.started");
    expect(started).toBeDefined();
    if (started?.type === "canary.started") {
      expect(started.payload.baselineFlowId).toBe(BASELINE_SPEC.id);
      expect(started.payload.canaryFlowId).toBe(CANARY_SPEC.id);
      expect(started.payload.canaryVersion).toBe("v2");
      expect(started.payload.trafficPct).toBe(100);
    }
  });

  it("shadow failure does not propagate to the caller", async () => {
    const deps = makeShadowDeps(1);
    const _store = new InMemoryCanaryStore();

    // Mock store.save to throw — shadow should swallow it silently
    const brokenStore = {
      save: vi.fn().mockRejectedValue(new Error("DB down")),
      list: vi.fn().mockResolvedValue([]),
    };

    const runner = new ShadowRunner(deps, {
      canarySpec: CANARY_SPEC,
      canaryStore: brokenStore,
    });

    // Should not throw even though shadow store fails
    await expect(runner.run(BASELINE_SPEC, "test", TEST_BUDGET)).resolves.toBeDefined();
    await tick();
  });
});
