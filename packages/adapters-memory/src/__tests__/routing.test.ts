import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS,
  DEFAULT_RULES,
  FakeModelPort,
  InMemoryAgentRegistry,
} from "../index.js";
import { HandoffPayloadSchema } from "@harness/contracts";
import {
  EscalationClassifier,
  LlmClassifier,
  RuleBasedClassifier,
  Router,
  RoutingGuard,
  buildContextSlice,
  estimateTokens,
} from "@harness/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouter(model?: FakeModelPort, withGuard?: RoutingGuard) {
  const registry = new InMemoryAgentRegistry(DEFAULT_AGENTS);
  const rule = new RuleBasedClassifier(DEFAULT_RULES);
  const escalation = new EscalationClassifier();
  if (model) {
    const llm = new LlmClassifier(model);
    return new Router([rule, llm, escalation], registry, withGuard);
  }
  return new Router([rule, escalation], registry, withGuard);
}

// ---------------------------------------------------------------------------
// RuleBasedClassifier
// ---------------------------------------------------------------------------

describe("RuleBasedClassifier", () => {
  const registry = new InMemoryAgentRegistry(DEFAULT_AGENTS);

  it("commits to financial-analyst for clear investment intent", async () => {
    const c = new RuleBasedClassifier(DEFAULT_RULES);
    const d = await c.classify(
      "I need to calculate the IRR and NPV for a real estate investment",
      registry.list(),
    );
    expect(d).not.toBeNull();
    expect(d?.targetAgent).toBe("financial-analyst");
    expect(d?.matchedBy).toBe("rule");
    expect(d?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("commits to operational-analyst for route optimisation intent", async () => {
    const c = new RuleBasedClassifier(DEFAULT_RULES);
    const d = await c.classify(
      "Optimise the delivery route for our logistics depot with 10 stops",
      registry.list(),
    );
    expect(d).not.toBeNull();
    expect(d?.targetAgent).toBe("operational-analyst");
  });

  it("commits to commercial-analyst for trade/pricing intent", async () => {
    const c = new RuleBasedClassifier(DEFAULT_RULES);
    const d = await c.classify(
      "Calculate landed cost for an import with HS code and duty rates",
      registry.list(),
    );
    expect(d).not.toBeNull();
    expect(d?.targetAgent).toBe("commercial-analyst");
  });

  it("returns null when no keywords match", async () => {
    const c = new RuleBasedClassifier(DEFAULT_RULES);
    const d = await c.classify("write me a poem about clouds", registry.list());
    expect(d).toBeNull();
  });

  it("returns null when keywords are split across multiple agents (ambiguous)", async () => {
    const c = new RuleBasedClassifier(DEFAULT_RULES);
    // "routing" → operational, "pricing" → commercial → confidence splits below threshold
    const d = await c.classify(
      "I need help with routing decisions and pricing strategies",
      registry.list(),
    );
    expect(d).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LlmClassifier
// ---------------------------------------------------------------------------

describe("LlmClassifier", () => {
  const registry = new InMemoryAgentRegistry(DEFAULT_AGENTS);

  it("classifies when LLM returns high-confidence JSON", async () => {
    const model = new FakeModelPort([
      FakeModelPort.textResponse(
        JSON.stringify({ agent: "operational-analyst", confidence: 0.88, reason: "Route task" }),
      ),
    ]);
    const c = new LlmClassifier(model);
    const d = await c.classify("something complicated", registry.list());
    expect(d).not.toBeNull();
    expect(d?.targetAgent).toBe("operational-analyst");
    expect(d?.matchedBy).toBe("llm");
    expect(d?.confidence).toBe(0.88);
    expect(model.callCount).toBe(1);
  });

  it("returns null when LLM confidence is below threshold", async () => {
    const model = new FakeModelPort([
      FakeModelPort.textResponse(
        JSON.stringify({ agent: "financial-analyst", confidence: 0.3, reason: "Uncertain" }),
      ),
    ]);
    const c = new LlmClassifier(model);
    const d = await c.classify("something vague", registry.list());
    expect(d).toBeNull();
  });

  it("returns null when LLM response is not valid JSON", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("I cannot decide.")]);
    const c = new LlmClassifier(model);
    const d = await c.classify("some intent", registry.list());
    expect(d).toBeNull();
  });

  it("returns null when LLM names an agent that does not exist in the registry", async () => {
    const model = new FakeModelPort([
      FakeModelPort.textResponse(
        JSON.stringify({ agent: "ghost-agent", confidence: 0.95, reason: "Unknown" }),
      ),
    ]);
    const c = new LlmClassifier(model);
    const d = await c.classify("some intent", registry.list());
    expect(d).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Router — Chain of Responsibility integration
// ---------------------------------------------------------------------------

describe("Router (Chain of Responsibility)", () => {
  // DoD: intent matching a rule → zero LLM calls
  it("routes via rule without making any LLM call", async () => {
    // FakeModelPort with no scripted responses — if called it returns an error result.
    const model = new FakeModelPort([]);
    const router = makeRouter(model);
    const decision = await router.route(
      "I need to calculate the IRR and NPV for a real estate investment",
    );
    expect(decision.matchedBy).toBe("rule");
    expect(decision.targetAgent).toBe("financial-analyst");
    expect(model.callCount).toBe(0); // zero LLM calls
  });

  // DoD: ambiguous intent → fallback to LLM classifier
  it("falls back to LLM classifier for ambiguous intents", async () => {
    const model = new FakeModelPort([
      FakeModelPort.textResponse(
        JSON.stringify({
          agent: "operational-analyst",
          confidence: 0.82,
          reason: "Logistics task",
        }),
      ),
    ]);
    const router = makeRouter(model);
    const decision = await router.route(
      "help me understand how to handle complex multi-step tasks",
    );
    expect(decision.matchedBy).toBe("llm");
    expect(decision.targetAgent).toBe("operational-analyst");
    expect(model.callCount).toBe(1);
  });

  // DoD: low confidence → escalation
  it("escalates when LLM returns low confidence", async () => {
    const model = new FakeModelPort([
      FakeModelPort.textResponse(
        JSON.stringify({ agent: "financial-analyst", confidence: 0.25, reason: "Uncertain" }),
      ),
    ]);
    const router = makeRouter(model);
    const decision = await router.route("something completely unrelated to any domain");
    expect(decision.matchedBy).toBe("escalation");
    expect(decision.targetAgent).toBe("");
  });

  it("escalates immediately when no LLM is configured and no keywords match", async () => {
    const router = makeRouter(); // no LlmClassifier
    const decision = await router.route("write a haiku about autumn leaves");
    expect(decision.matchedBy).toBe("escalation");
  });
});

// ---------------------------------------------------------------------------
// RoutingGuard — hop limit and cycle detection
// ---------------------------------------------------------------------------

describe("RoutingGuard", () => {
  it("allows the first agent registration", () => {
    const guard = new RoutingGuard(5);
    expect(guard.record("financial-analyst").ok).toBe(true);
    expect(guard.hopCount).toBe(1);
  });

  it("allows sequential hops within the limit", () => {
    const guard = new RoutingGuard(5);
    expect(guard.record("financial-analyst").ok).toBe(true);
    expect(guard.record("commercial-analyst").ok).toBe(true);
    expect(guard.record("operational-analyst").ok).toBe(true);
    expect(guard.hopCount).toBe(3);
  });

  // DoD: cycle A → B → A detected and broken
  it("detects cycle A → B → A", () => {
    const guard = new RoutingGuard(5);
    guard.record("agent-a");
    guard.record("agent-b");
    const result = guard.record("agent-a"); // revisit → cycle
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cycle_detected");
      expect(result.path).toEqual(["agent-a", "agent-b", "agent-a"]);
    }
  });

  it("detects longer cycle A → B → C → A", () => {
    const guard = new RoutingGuard(5);
    guard.record("agent-a");
    guard.record("agent-b");
    guard.record("agent-c");
    const result = guard.record("agent-a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cycle_detected");
  });

  it("enforces hop limit", () => {
    const guard = new RoutingGuard(2); // at most 2 agents
    guard.record("agent-a");
    guard.record("agent-b");
    const result = guard.record("agent-c"); // 3rd → exceeds limit
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hop_limit_exceeded");
  });

  it("exposes the current path in order", () => {
    const guard = new RoutingGuard(5);
    guard.record("agent-a");
    guard.record("agent-b");
    expect(guard.path).toEqual(["agent-a", "agent-b"]);
  });
});

// ---------------------------------------------------------------------------
// Router + RoutingGuard — cycle detected end-to-end through the router
// ---------------------------------------------------------------------------

describe("Router + RoutingGuard — cycle protection", () => {
  // DoD: cycle A → B → A is detected and the Router emits an escalation
  it("converts a cycle detection into an escalation decision", async () => {
    const guard = new RoutingGuard(5);
    const router = makeRouter(undefined, guard);

    // First routing: clear financial intent
    const d1 = await router.route("calculate IRR and NPV for a property investment");
    expect(d1.targetAgent).toBe("financial-analyst");

    // Second routing: clear commercial intent
    const d2 = await router.route("calculate the landed cost and duty for an HS code import");
    expect(d2.targetAgent).toBe("commercial-analyst");

    // Third routing: back to financial → cycle
    const d3 = await router.route("analyze the investment cash flows and IRR again");
    expect(d3.matchedBy).toBe("escalation");
    expect(d3.reason).toContain("cycle");
  });
});

// ---------------------------------------------------------------------------
// HandoffPayload — typed schema validation (DoD: invalid payload rejected)
// ---------------------------------------------------------------------------

describe("HandoffPayload schema validation", () => {
  const validPayload = {
    fromAgent: "financial-analyst",
    toAgent: "commercial-analyst",
    workflowId: "wf-001",
    stepId: "step-42",
    context: { taskDescription: "Analyse trade cost" },
    reason: "Task requires trade domain expertise",
    matchedBy: "rule" as const,
    confidence: 0.95,
    hop: 0,
    contextSlice: [{ role: "user", content: "task goal" }],
  };

  it("accepts a fully valid handoff payload", () => {
    expect(HandoffPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  // DoD: payload mismatch → handoff rejected, workflow does not crash
  it("rejects payload with missing required fields without throwing", () => {
    const result = HandoffPayloadSchema.safeParse({ fromAgent: "financial-analyst" });
    expect(result.success).toBe(false);
    // Validation returns an error value — no exception thrown, runtime is safe.
  });

  it("rejects confidence below 0", () => {
    expect(
      HandoffPayloadSchema.safeParse({ ...validPayload, confidence: -0.1 }).success,
    ).toBe(false);
  });

  it("rejects confidence above 1", () => {
    expect(
      HandoffPayloadSchema.safeParse({ ...validPayload, confidence: 1.1 }).success,
    ).toBe(false);
  });

  it("accepts confidence at the boundary values 0 and 1", () => {
    expect(
      HandoffPayloadSchema.safeParse({ ...validPayload, confidence: 0 }).success,
    ).toBe(true);
    expect(
      HandoffPayloadSchema.safeParse({ ...validPayload, confidence: 1 }).success,
    ).toBe(true);
  });

  it("rejects an unknown matchedBy value", () => {
    expect(
      HandoffPayloadSchema.safeParse({ ...validPayload, matchedBy: "random-string" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildContextSlice — context is measurably smaller than full history (DoD)
// ---------------------------------------------------------------------------

describe("buildContextSlice — context size", () => {
  // DoD: size of target agent context measurably smaller than full history
  it("produces a token-bounded slice that is strictly smaller than full history", () => {
    const fullHistory = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}: ${"x".repeat(200)}`, // ~50 tokens each → ~1 000 tokens total
    }));

    const fullTokens = estimateTokens(JSON.stringify(fullHistory).length);
    const maxBudget = Math.floor(fullTokens / 3); // allow only 1/3 of full history

    const slice = buildContextSlice(fullHistory, maxBudget);
    const sliceTokens = estimateTokens(JSON.stringify(slice).length);

    expect(sliceTokens).toBeLessThan(fullTokens);
    // First message (task goal) is always preserved.
    expect(slice[0]).toEqual(fullHistory[0]);
    // Slice must not be empty.
    expect(slice.length).toBeGreaterThan(0);
  });

  it("returns the full history when it fits within the budget", () => {
    const history = [
      { role: "user" as const, content: "goal" },
      { role: "assistant" as const, content: "result" },
    ];
    const slice = buildContextSlice(history, 100_000);
    expect(slice).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// reducer — agent.handoff advances seq only (no status change)
// ---------------------------------------------------------------------------

describe("reducer — agent.handoff event", () => {
  it("advances seq without changing workflow status", async () => {
    const { reduce } = await import("@harness/core/domain");
    const { initialWorkflowState } = await import("@harness/core/domain");

    const state = { ...initialWorkflowState("wf-test"), seq: 2, status: "running" as const };

    const handoffEvent = {
      id: "ev-1",
      workflowId: "wf-test",
      seq: 3,
      at: new Date().toISOString(),
      type: "agent.handoff" as const,
      payload: {
        fromAgent: "financial-analyst",
        toAgent: "commercial-analyst",
        reason: "Routing",
        matchedBy: "rule" as const,
        confidence: 1.0,
        hop: 0,
        contextSlice: [],
      },
    };

    const next = reduce(state, handoffEvent);
    expect(next.seq).toBe(3);
    expect(next.status).toBe("running");
  });
});
