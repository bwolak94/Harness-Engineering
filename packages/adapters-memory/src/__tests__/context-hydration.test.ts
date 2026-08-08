import type { TaskPacket } from "@harness/contracts";
import {
  type ContextBudget,
  HarnessRuntime,
  type HarnessRuntimeDeps,
  type MemorySummary,
  NoopSummarizer,
  type SummarizerPort,
} from "@harness/core";
import type { ModelMessage } from "@harness/core";
/**
 * Context Hydration integration tests.
 *
 * Runs HarnessRuntime with InMemoryMemoryStore, verifying:
 *   - context.hydrated events are emitted
 *   - prefix hash is identical between steps (same system + tools)
 *   - summarization fires when eviction threshold is reached
 *   - summarization is replayed from event log on resume (cost = 0)
 *   - long workflows stay under the context token budget
 */
import { describe, expect, it, vi } from "vitest";
import {
  FakeModelPort,
  FixedClock,
  InMemoryEventLog,
  InMemoryMemoryStore,
  InMemoryStateStore,
  InMemoryToolRegistry,
  SeededIdPort,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_TIME = new Date("2026-08-08T12:00:00.000Z").getTime();

const ECHO_DEFINITION = {
  name: "echo",
  description: "echo",
  inputSchema: {},
  outputSchema: {},
  costHint: "free" as const,
  dangerous: false,
  idempotent: true,
};

function makeTask(id = "wf-t09"): TaskPacket {
  return {
    id,
    goal: "Test task for context hydration",
    budget: {
      maxTokens: 100_000,
      maxSteps: 500,
      maxWallClockMs: 60_000,
      maxCostUsd: 100,
    },
  };
}

function makeRegistry() {
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.register({
    definition: ECHO_DEFINITION,
    execute: async () => ({ ok: true as const, value: "result" }),
  });
  return toolRegistry;
}

type ExtraDeps = {
  memoryStore?: InMemoryMemoryStore;
  summarizer?: SummarizerPort;
  contextBudget?: ContextBudget;
};

function makeRuntime(model: FakeModelPort, extra: ExtraDeps = {}) {
  const eventLog = new InMemoryEventLog();
  const stateStore = new InMemoryStateStore();
  const toolRegistry = new InMemoryToolRegistry();
  const clock = new FixedClock(FIXED_TIME);
  const idPort = new SeededIdPort();

  const deps: HarnessRuntimeDeps = {
    model,
    eventLog,
    stateStore,
    toolRegistry,
    clock,
    idPort,
    middleware: [],
    ...(extra.memoryStore !== undefined && { memoryStore: extra.memoryStore }),
    ...(extra.summarizer !== undefined && { summarizer: extra.summarizer }),
    ...(extra.contextBudget !== undefined && { contextBudget: extra.contextBudget }),
  };

  const runtime = new HarnessRuntime(deps);
  return { runtime, eventLog, stateStore, toolRegistry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context.hydrated events", () => {
  it("emits a context.hydrated event before each model call", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("Done")]);
    const { runtime, eventLog } = makeRuntime(model);
    await runtime.run(makeTask());

    const events = await eventLog.read("wf-t09");
    const hydratedEvents = events.filter((e) => e.type === "context.hydrated");
    expect(hydratedEvents).toHaveLength(1);
  });

  it("context.hydrated contains token breakdown per section", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("Done")]);
    const { runtime, eventLog } = makeRuntime(model);
    await runtime.run(makeTask());

    const events = await eventLog.read("wf-t09");
    const hydratedEvt = events.find((e) => e.type === "context.hydrated");
    expect(hydratedEvt).toBeDefined();
    if (hydratedEvt?.type !== "context.hydrated") return;

    const { tokensBySection, totalTokens, prefixHash } = hydratedEvt.payload;
    expect(tokensBySection.system).toBeGreaterThan(0);
    expect(tokensBySection.recentTurns).toBeGreaterThan(0);
    expect(totalTokens).toBeGreaterThan(0);
    expect(prefixHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("prefix hash stability", () => {
  it("prefix hash is identical across all steps (system + tools unchanged)", async () => {
    const model = new FakeModelPort([
      FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: {} }]),
      FakeModelPort.toolCallResponse([{ id: "c2", name: "echo", args: {} }]),
      FakeModelPort.textResponse("Done"),
    ]);

    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const toolRegistry = makeRegistry();
    const clock = new FixedClock(FIXED_TIME);
    const idPort = new SeededIdPort();

    const runtime = new HarnessRuntime({
      model,
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort,
      middleware: [],
    });

    await runtime.run(makeTask());

    const events = await eventLog.read("wf-t09");
    const hashes = events
      .filter((e) => e.type === "context.hydrated")
      .map((e) => {
        if (e.type !== "context.hydrated") return "";
        return e.payload.prefixHash;
      });

    // All hashes must be identical (system prompt and tools never changed).
    expect(hashes.length).toBeGreaterThan(1);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(1);
  });
});

describe("NoopMemoryStore (default)", () => {
  it("runtime works without explicit memoryStore (uses NoopMemoryStore)", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("Done")]);
    const { runtime } = makeRuntime(model);
    const state = await runtime.run(makeTask());
    expect(state.status).toBe("completed");
  });
});

describe("InMemoryMemoryStore", () => {
  it("facts are injected into context when memoryStore has facts", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await memoryStore.setFact("wf-t09", "user_name", "Alice");

    let capturedMessages: readonly ModelMessage[] = [];
    const model = new FakeModelPort([FakeModelPort.textResponse("Done")]);
    const spy = vi.spyOn(model, "generate").mockImplementation(async (ctx) => {
      capturedMessages = ctx.messages;
      return FakeModelPort.textResponse("Done");
    });

    const { runtime } = makeRuntime(model, { memoryStore });
    await runtime.run(makeTask());

    spy.mockRestore();

    const factsMsg = capturedMessages.find(
      (m) => m.role === "system" && m.content?.includes("Persistent Facts"),
    );
    expect(factsMsg).toBeDefined();
    expect(factsMsg?.content).toContain("user_name: Alice");
  });

  it("summaries are injected into context when memoryStore has summaries", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const summary: MemorySummary = {
      id: "sum-1",
      fromSeq: 1,
      toSeq: 5,
      content: "Earlier the user asked about pricing.",
      messageCount: 4,
      createdAt: new Date(0).toISOString(),
    };
    await memoryStore.addSummary("wf-t09", summary);

    let capturedMessages: readonly ModelMessage[] = [];
    const model = new FakeModelPort([FakeModelPort.textResponse("Done")]);
    const spy = vi.spyOn(model, "generate").mockImplementation(async (ctx) => {
      capturedMessages = ctx.messages;
      return FakeModelPort.textResponse("Done");
    });

    const { runtime } = makeRuntime(model, { memoryStore });
    await runtime.run(makeTask());

    spy.mockRestore();

    const sumMsg = capturedMessages.find(
      (m) => m.role === "system" && m.content?.includes("Conversation Summary"),
    );
    expect(sumMsg).toBeDefined();
    expect(sumMsg?.content).toContain("Earlier the user asked about pricing.");
  });

  it("summary is idempotent — adding the same summary twice does not duplicate it", async () => {
    const store = new InMemoryMemoryStore();
    const summary: MemorySummary = {
      id: "dup-1",
      fromSeq: 1,
      toSeq: 3,
      content: "Some summary",
      messageCount: 2,
      createdAt: new Date(0).toISOString(),
    };
    await store.addSummary("wf-1", summary);
    await store.addSummary("wf-1", summary);
    const summaries = await store.getSummaries("wf-1");
    expect(summaries).toHaveLength(1);
  });
});

describe("summarization — threshold-triggered", () => {
  it("emits context.summarized event when eviction threshold is reached", async () => {
    const tightBudget: ContextBudget = {
      systemTokens: 500,
      factsTokens: 0,
      summariesTokens: 1_000,
      recentTurnsTokens: 20, // ~80 chars — only the goal fits
      summarizationThreshold: 1, // fire on first eviction
    };

    const memoryStore = new InMemoryMemoryStore();
    const summarizer = new NoopSummarizer();

    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const toolRegistry = makeRegistry();
    const clock = new FixedClock(FIXED_TIME);
    const idPort = new SeededIdPort();

    const model = new FakeModelPort([
      FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: {} }]),
      FakeModelPort.toolCallResponse([{ id: "c2", name: "echo", args: {} }]),
      FakeModelPort.textResponse("Done"),
    ]);

    const runtime = new HarnessRuntime({
      model,
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort,
      middleware: [],
      memoryStore,
      summarizer,
      contextBudget: tightBudget,
    });

    await runtime.run(makeTask());

    const events = await eventLog.read("wf-t09");
    const summarizedEvents = events.filter((e) => e.type === "context.summarized");
    expect(summarizedEvents.length).toBeGreaterThan(0);
    expect(memoryStore.summaryCount("wf-t09")).toBeGreaterThan(0);
  });

  it("summarization is replayed from event log on resume (cost = 0 Summarizer calls)", async () => {
    let summarizerCallCount = 0;
    const trackingSummarizer: SummarizerPort = {
      async summarize(_wfId, messages) {
        summarizerCallCount++;
        return `[Summary of ${messages.length} messages]`;
      },
    };

    const tightBudget: ContextBudget = {
      systemTokens: 500,
      factsTokens: 0,
      summariesTokens: 1_000,
      recentTurnsTokens: 20,
      summarizationThreshold: 1,
    };

    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const toolRegistry = makeRegistry();
    const clock = new FixedClock(FIXED_TIME);
    const memoryStore1 = new InMemoryMemoryStore();

    const runtime1 = new HarnessRuntime({
      model: new FakeModelPort([
        FakeModelPort.toolCallResponse([{ id: "c1", name: "echo", args: {} }]),
        FakeModelPort.toolCallResponse([{ id: "c2", name: "echo", args: {} }]),
        FakeModelPort.textResponse("Done"),
      ]),
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort: new SeededIdPort(),
      middleware: [],
      memoryStore: memoryStore1,
      summarizer: trackingSummarizer,
      contextBudget: tightBudget,
    });

    await runtime1.run(makeTask());
    const callsAfterRun = summarizerCallCount;
    expect(callsAfterRun).toBeGreaterThan(0);

    // Reset counter and use fresh memory store for resume.
    summarizerCallCount = 0;
    const memoryStore2 = new InMemoryMemoryStore();

    const runtime2 = new HarnessRuntime({
      model: new FakeModelPort([FakeModelPort.textResponse("Done")]),
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort: new SeededIdPort(),
      middleware: [],
      memoryStore: memoryStore2,
      summarizer: trackingSummarizer,
      contextBudget: tightBudget,
    });

    // Resume — workflow is already completed, returns immediately.
    // The key invariant: memoryStore2 is repopulated from context.summarized events.
    await runtime2.resume("wf-t09");

    // Summarizer was NOT called during resume.
    expect(summarizerCallCount).toBe(0);

    // New store has same summaries as original.
    const summaries1 = await memoryStore1.getSummaries("wf-t09");
    const summaries2 = await memoryStore2.getSummaries("wf-t09");
    expect(summaries2.length).toBe(summaries1.length);
  });
});

describe("context size bounded over long workflows", () => {
  it("total context tokens stay under budget for a 50-step workflow", async () => {
    const tightBudget: ContextBudget = {
      systemTokens: 500,
      factsTokens: 200,
      summariesTokens: 1_000,
      recentTurnsTokens: 1_000,
      summarizationThreshold: 5,
    };

    const maxAllowed =
      tightBudget.systemTokens +
      tightBudget.factsTokens +
      tightBudget.summariesTokens +
      tightBudget.recentTurnsTokens;

    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const toolRegistry = new InMemoryToolRegistry();
    toolRegistry.register({
      definition: ECHO_DEFINITION,
      execute: async () => ({ ok: true as const, value: "x".repeat(300) }),
    });
    const clock = new FixedClock(FIXED_TIME);
    const idPort = new SeededIdPort();
    const memoryStore = new InMemoryMemoryStore();

    const responses = [
      ...Array.from({ length: 50 }, (_, i) =>
        FakeModelPort.toolCallResponse([{ id: `c${i}`, name: "echo", args: {} }]),
      ),
      FakeModelPort.textResponse("Done"),
    ];
    const model = new FakeModelPort(responses);

    const runtime = new HarnessRuntime({
      model,
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort,
      middleware: [],
      memoryStore,
      contextBudget: tightBudget,
    });

    await runtime.run(makeTask());

    const events = await eventLog.read("wf-t09");
    const hydratedEvents = events.filter((e) => e.type === "context.hydrated");

    expect(hydratedEvents.length).toBeGreaterThan(0);
    for (const evt of hydratedEvents) {
      if (evt.type !== "context.hydrated") continue;
      expect(evt.payload.totalTokens).toBeLessThanOrEqual(maxAllowed);
    }
  });
});
