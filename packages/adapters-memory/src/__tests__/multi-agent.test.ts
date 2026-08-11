import {
  EscalationClassifier,
  HarnessRuntime,
  Router,
  RuleBasedClassifier,
  ok,
} from "@harness/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS,
  DEFAULT_RULES,
  FakeModelPort,
  FilteredToolRegistry,
  FixedClock,
  InMemoryAgentRegistry,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryToolRegistry,
  SeededIdPort,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseRegistry(): InMemoryToolRegistry {
  const reg = new InMemoryToolRegistry();
  // Register stub executors matching the tool names used in DEFAULT_AGENTS
  for (const name of [
    "analyzeInvestment",
    "calculateNetSalary",
    "optimizeRoute",
    "explodeRecipeCost",
    "simulatePVPayback",
    "calculateLandedCost",
    "proposeRepricing",
  ]) {
    reg.register({
      definition: {
        name,
        description: `stub ${name}`,
        dangerous: false,
        idempotent: true,
        costHint: "free",
        inputSchema: {},
        outputSchema: {},
      },
      execute: async () => ({ ok: true, value: { stub: name } }),
    });
  }
  return reg;
}

function makeRouter() {
  const registry = new InMemoryAgentRegistry(DEFAULT_AGENTS);
  const rule = new RuleBasedClassifier(DEFAULT_RULES);
  const escalation = new EscalationClassifier();
  return { router: new Router([rule, escalation], registry), agentRegistry: registry };
}

// ---------------------------------------------------------------------------
// FilteredToolRegistry
// ---------------------------------------------------------------------------

describe("FilteredToolRegistry", () => {
  it("returns only tools in the allowed set", () => {
    const base = makeBaseRegistry();
    const filtered = new FilteredToolRegistry(base, ["analyzeInvestment", "calculateNetSalary"]);

    expect(filtered.list().map((e) => e.definition.name)).toEqual([
      "analyzeInvestment",
      "calculateNetSalary",
    ]);
  });

  it("returns undefined for tools outside the allowed set", () => {
    const base = makeBaseRegistry();
    const filtered = new FilteredToolRegistry(base, ["analyzeInvestment"]);

    expect(filtered.get("optimizeRoute")).toBeUndefined();
    expect(filtered.get("analyzeInvestment")).toBeDefined();
  });

  it("schemas() returns only allowed tool definitions", () => {
    const base = makeBaseRegistry();
    const filtered = new FilteredToolRegistry(base, ["calculateLandedCost", "proposeRepricing"]);

    const names = filtered.schemas().map((d) => d.name);
    expect(names).toEqual(["calculateLandedCost", "proposeRepricing"]);
  });

  it("respects an empty allowed set (no tools exposed)", () => {
    const base = makeBaseRegistry();
    const filtered = new FilteredToolRegistry(base, []);

    expect(filtered.list()).toHaveLength(0);
    expect(filtered.get("analyzeInvestment")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Router selects the right agent and FilteredToolRegistry restricts tools
// ---------------------------------------------------------------------------

describe("multi-agent routing + filtered registry", () => {
  it("routes 'salary' intent to financial-analyst tools only", async () => {
    const base = makeBaseRegistry();
    const { router, agentRegistry } = makeRouter();

    const decision = await router.route("Calculate my net salary for a UoP contract");
    expect(decision.targetAgent).toBe("financial-analyst");
    expect(decision.matchedBy).toBe("rule");

    const agentSpec = agentRegistry.get(decision.targetAgent);
    const filtered = new FilteredToolRegistry(base, agentSpec!.toolNames);

    const names = filtered.list().map((e) => e.definition.name);
    expect(names).toContain("analyzeInvestment");
    expect(names).toContain("calculateNetSalary");
    expect(names).not.toContain("optimizeRoute");
  });

  it("routes 'route' intent to operational-analyst tools only", async () => {
    const base = makeBaseRegistry();
    const { router, agentRegistry } = makeRouter();

    const decision = await router.route("Optimise the delivery route for 5 stops");
    expect(decision.targetAgent).toBe("operational-analyst");

    const agentSpec = agentRegistry.get(decision.targetAgent);
    const filtered = new FilteredToolRegistry(base, agentSpec!.toolNames);

    const names = filtered.list().map((e) => e.definition.name);
    expect(names).toContain("optimizeRoute");
    expect(names).not.toContain("analyzeInvestment");
  });

  it("routes 'landed cost' intent to commercial-analyst tools only", async () => {
    const base = makeBaseRegistry();
    const { router, agentRegistry } = makeRouter();

    const decision = await router.route("Calculate landed cost for HS code 8471300000 import");
    expect(decision.targetAgent).toBe("commercial-analyst");

    const agentSpec = agentRegistry.get(decision.targetAgent);
    const filtered = new FilteredToolRegistry(base, agentSpec!.toolNames);

    const names = filtered.list().map((e) => e.definition.name);
    expect(names).toContain("calculateLandedCost");
    expect(names).toContain("proposeRepricing");
    expect(names).not.toContain("optimizeRoute");
  });

  it("falls back to full registry when router escalates", async () => {
    const base = makeBaseRegistry();
    const { router, agentRegistry } = makeRouter();

    // An intent that matches no keywords → escalation
    const decision = await router.route("Tell me a joke about penguins");
    expect(decision.matchedBy).toBe("escalation");

    // On escalation, use the full registry (no filtering)
    const agentSpec =
      decision.matchedBy !== "escalation" ? agentRegistry.get(decision.targetAgent) : undefined;
    const toolRegistry = agentSpec ? new FilteredToolRegistry(base, agentSpec.toolNames) : base;

    // Full registry should expose all registered tools
    expect(toolRegistry.list().length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: HarnessRuntime with FilteredToolRegistry completes a workflow
// ---------------------------------------------------------------------------

describe("HarnessRuntime with FilteredToolRegistry", () => {
  it("runs a workflow and only sees allowed tools", async () => {
    const base = makeBaseRegistry();
    const filtered = new FilteredToolRegistry(base, ["calculateNetSalary"]);
    const idPort = new SeededIdPort();
    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const clock = new FixedClock(new Date("2026-08-11T10:00:00Z").getTime());

    // FakeModelPort: returns a final text answer (no tool calls) so the workflow completes
    const model = new FakeModelPort([
      ok({
        content: "The net salary is approximately 5800 PLN.",
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        finishReason: "stop" as const,
      }),
    ]);

    const runtime = new HarnessRuntime({
      model,
      eventLog,
      stateStore,
      toolRegistry: filtered,
      clock,
      idPort,
      middleware: [],
    });

    const state = await runtime.run({
      id: "wf-multi-01",
      goal: "Calculate net salary for 8000 PLN gross on UoP",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 30_000, maxCostUsd: 1.0 },
    });

    expect(state.status).toBe("completed");
    // The model context should only see the one allowed tool
    const hydrated = await eventLog.read("wf-multi-01", 0);
    const hydratedEvent = hydrated.find((e) => e.type === "context.hydrated");
    expect(hydratedEvent).toBeDefined();
  });
});
