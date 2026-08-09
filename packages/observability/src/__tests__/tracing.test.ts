import {
  FakeModelPort,
  FixedClock,
  InMemoryApprovalStore,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryToolRegistry,
  SeededIdPort,
} from "@harness/adapters-memory";
import type { TaskPacket } from "@harness/contracts";
import { HarnessRuntime } from "@harness/core";
import { createDefaultToolExecutors } from "@harness/core/tools";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateCostUsd, resolvePricing } from "../cost-estimator.js";
import {
  ATTR_HARNESS_TOOL_NAME,
  ATTR_HARNESS_WORKFLOW_ID,
  ATTR_HARNESS_WORKFLOW_STATUS,
} from "../semconv.js";
import { TracingModelAdapter } from "../tracing-model-adapter.js";
import { TracingRuntimeAdapter } from "../tracing-runtime-adapter.js";
import { withBudgetThreshold } from "../with-budget-threshold.js";
import { withTracing } from "../with-tracing.js";

// ---------------------------------------------------------------------------
// OTel test setup — in-memory provider, no real exporter
// ---------------------------------------------------------------------------

function createTestTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  // AsyncLocalStorageContextManager is required so context.with() propagates
  // the active span through await boundaries (BasicTracerProvider does not
  // register a context manager automatically unlike NodeTracerProvider).
  provider.register({ contextManager: new AsyncLocalStorageContextManager() });

  const tracer = provider.getTracer("test");
  return { tracer, exporter, provider };
}

function finishedSpans(exporter: InMemorySpanExporter) {
  return exporter.getFinishedSpans();
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeTask(id: string): TaskPacket {
  return {
    id,
    goal: "test task",
    budget: {
      maxTokens: 10_000,
      maxSteps: 10,
      maxWallClockMs: 60_000,
      maxCostUsd: 1.0,
    },
  };
}

function buildRuntime(model: FakeModelPort, tracer: ReturnType<typeof createTestTracer>["tracer"]) {
  const eventLog = new InMemoryEventLog();
  const stateStore = new InMemoryStateStore();
  const toolRegistry = new InMemoryToolRegistry();
  for (const executor of createDefaultToolExecutors()) {
    toolRegistry.register(executor);
  }
  const clock = new FixedClock(1_000_000);
  const idPort = new SeededIdPort();
  const approvalStore = new InMemoryApprovalStore();

  const tracingModel = new TracingModelAdapter(model, tracer);

  const inner = new HarnessRuntime({
    model: tracingModel,
    eventLog,
    stateStore,
    toolRegistry,
    clock,
    idPort,
    middleware: [withTracing(tracer)],
    approvalStore,
  });

  const runtime = new TracingRuntimeAdapter(inner, tracer);
  return { runtime, eventLog, stateStore };
}

// ---------------------------------------------------------------------------
// Cost estimator
// ---------------------------------------------------------------------------

describe("cost-estimator", () => {
  it("estimates cost for a known model (claude-sonnet-4)", () => {
    const cost = estimateCostUsd("claude-sonnet-4-6", 1_000_000, 500_000);
    // 1M input @ $3/1M + 0.5M output @ $15/1M = $3 + $7.5 = $10.5
    expect(cost).toBe(10.5);
  });

  it("uses default pricing for unknown model", () => {
    const { inputPer1M, outputPer1M } = resolvePricing("unknown-model-xyz");
    expect(inputPer1M).toBe(3.0);
    expect(outputPer1M).toBe(15.0);
  });

  it("uses longest-prefix match (gpt-4o-mini preferred over gpt-4o)", () => {
    const { inputPer1M } = resolvePricing("gpt-4o-mini");
    expect(inputPer1M).toBe(0.15);
  });

  it("returns zero cost for zero tokens", () => {
    expect(estimateCostUsd("gpt-4o", 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// withTracing — tool-level spans
// ---------------------------------------------------------------------------

describe("withTracing middleware", () => {
  let exporter: InMemorySpanExporter;
  let tracer: ReturnType<typeof createTestTracer>["tracer"];

  beforeEach(() => {
    const testSetup = createTestTracer();
    exporter = testSetup.exporter;
    tracer = testSetup.tracer;
  });

  it("creates a tool_call span for each tool invocation", async () => {
    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 1_000_000,
        rentRoll: [],
        opex: [],
        loan: { amount: 800_000, rate: 0.05, years: 20, type: "annuity" },
        horizonYears: 5,
        exitCapRate: 0.06,
      }),
      FakeModelPort.textResponse("Done"),
    ]);

    const { runtime } = buildRuntime(model, tracer);
    await runtime.run(makeTask("wf-t1"));

    const spans = finishedSpans(exporter);
    const toolSpan = spans.find((s) => s.name.startsWith("tool_call"));
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes[ATTR_HARNESS_TOOL_NAME]).toBe("analyzeInvestment");
    expect(toolSpan?.attributes[ATTR_HARNESS_WORKFLOW_ID]).toBe("wf-t1");
  });

  it("marks the span as error when the tool fails", async () => {
    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        /* invalid args — VALIDATION_ERROR */
      }),
      FakeModelPort.textResponse("Done"),
    ]);

    const { runtime } = buildRuntime(model, tracer);
    await runtime.run(makeTask("wf-t2"));

    const spans = finishedSpans(exporter);
    const toolSpan = spans.find((s) => s.name.startsWith("tool_call"));
    // The span status code for error is 2 in OTel SDK
    expect(toolSpan?.status.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TracingModelAdapter — LLM-level spans
// ---------------------------------------------------------------------------

describe("TracingModelAdapter", () => {
  let exporter: InMemorySpanExporter;
  let tracer: ReturnType<typeof createTestTracer>["tracer"];

  beforeEach(() => {
    const testSetup = createTestTracer();
    exporter = testSetup.exporter;
    tracer = testSetup.tracer;
  });

  it("creates a gen_ai.chat span for each model call", async () => {
    const model = FakeModelPort.textOnly("Hello");
    const { runtime } = buildRuntime(model, tracer);
    await runtime.run(makeTask("wf-m1"));

    const spans = finishedSpans(exporter);
    const llmSpan = spans.find((s) => s.name === "gen_ai.chat");
    expect(llmSpan).toBeDefined();
    expect(llmSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(llmSpan?.attributes["gen_ai.usage.output_tokens"]).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// TracingRuntimeAdapter — workflow-level spans
// ---------------------------------------------------------------------------

describe("TracingRuntimeAdapter", () => {
  let exporter: InMemorySpanExporter;
  let tracer: ReturnType<typeof createTestTracer>["tracer"];

  beforeEach(() => {
    const testSetup = createTestTracer();
    exporter = testSetup.exporter;
    tracer = testSetup.tracer;
  });

  it("creates a workflow.run span", async () => {
    const model = FakeModelPort.textOnly("Done");
    const { runtime } = buildRuntime(model, tracer);
    await runtime.run(makeTask("wf-r1"));

    const spans = finishedSpans(exporter);
    const workflowSpan = spans.find((s) => s.name === "workflow.run");
    expect(workflowSpan).toBeDefined();
    expect(workflowSpan?.attributes[ATTR_HARNESS_WORKFLOW_ID]).toBe("wf-r1");
    expect(workflowSpan?.attributes[ATTR_HARNESS_WORKFLOW_STATUS]).toBe("completed");
  });

  it("tool spans are children of the workflow span", async () => {
    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("analyzeInvestment", {
        price: 500_000,
        rentRoll: [],
        opex: [],
        loan: { amount: 400_000, rate: 0.05, years: 10, type: "annuity" },
        horizonYears: 3,
        exitCapRate: 0.07,
      }),
      FakeModelPort.textResponse("Done"),
    ]);

    const { runtime } = buildRuntime(model, tracer);
    await runtime.run(makeTask("wf-r2"));

    const spans = finishedSpans(exporter);
    const workflowSpan = spans.find((s) => s.name === "workflow.run");
    const toolSpan = spans.find((s) => s.name.startsWith("tool_call"));

    expect(workflowSpan).toBeDefined();
    expect(toolSpan).toBeDefined();

    // Tool span's parent trace ID must match the workflow span's trace ID.
    expect(toolSpan?.spanContext().traceId).toBe(workflowSpan?.spanContext().traceId);
    // Tool span's parent span ID must be the workflow span.
    expect(toolSpan?.parentSpanId).toBe(workflowSpan?.spanContext().spanId);
  });

  it("workflow span is marked error for failed workflows", async () => {
    // Exhaust model responses immediately to trigger a model error → workflow.failed
    const model = new FakeModelPort([]); // no responses → error on first call
    const { runtime } = buildRuntime(model, tracer);
    const state = await runtime.run(makeTask("wf-r3"));

    expect(state.status).toBe("failed");
    const spans = finishedSpans(exporter);
    const workflowSpan = spans.find((s) => s.name === "workflow.run");
    expect(workflowSpan?.status.code).toBe(2); // ERROR
  });
});

// ---------------------------------------------------------------------------
// withBudgetThreshold — threshold events
// ---------------------------------------------------------------------------

describe("withBudgetThreshold middleware", () => {
  it("does not emit threshold events when budget is within limits", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    const tracer = provider.getTracer("test");

    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const toolRegistry = new InMemoryToolRegistry();
    for (const executor of createDefaultToolExecutors()) toolRegistry.register(executor);
    const clock = new FixedClock(1_000_000);
    const idPort = new SeededIdPort();
    const approvalStore = new InMemoryApprovalStore();

    const model = FakeModelPort.textOnly("Done");
    const inner = new HarnessRuntime({
      model,
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort,
      middleware: [withBudgetThreshold({ thresholds: [0.8] })],
      approvalStore,
    });
    const runtime = new TracingRuntimeAdapter(inner, tracer);

    await runtime.run(makeTask("wf-bt1"));

    const events = await eventLog.read("wf-bt1");
    const thresholdEvents = events.filter((e) => e.type === "budget.threshold.exceeded");
    // No tool calls → no budget usage → no threshold crossing
    expect(thresholdEvents).toHaveLength(0);
  });
});
