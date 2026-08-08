import { describe, expect, it } from "vitest";
import type { ModelMessage } from "../../ports/model.port.js";
import {
  type ContextBudget,
  ContextHydrator,
  DEFAULT_CONTEXT_BUDGET,
  computePrefixHash,
  selectRecentTurns,
} from "../context-hydrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(content: string): ModelMessage {
  return { role: "user", content };
}

function assistantMsg(content: string): ModelMessage {
  return { role: "assistant", content };
}

function toolMsg(content: string): ModelMessage {
  return { role: "tool", content, toolCallId: "c1", name: "myTool" };
}

const SYSTEM = "You are a helpful assistant.";
const NO_TOOLS = [] as const;

// ---------------------------------------------------------------------------
// selectRecentTurns
// ---------------------------------------------------------------------------

describe("selectRecentTurns", () => {
  it("returns empty arrays for empty history", () => {
    const { kept, evicted } = selectRecentTurns([], 1_000);
    expect(kept).toHaveLength(0);
    expect(evicted).toHaveLength(0);
  });

  it("keeps all messages when they fit in budget", () => {
    const history = [userMsg("goal"), assistantMsg("step1"), toolMsg("result1")];
    const { kept, evicted } = selectRecentTurns(history, 10_000);
    expect(kept).toHaveLength(3);
    expect(evicted).toHaveLength(0);
  });

  it("always keeps the first message (task goal)", () => {
    // Budget just enough for the first message, not the rest.
    const goal = "x".repeat(100);
    const history = [userMsg(goal), assistantMsg("a".repeat(400)), toolMsg("b".repeat(400))];
    // Budget ≈ 1000 chars / 4 = 250 tokens; goal is 100 chars = 25 tokens.
    const { kept, evicted } = selectRecentTurns(history, 30);
    expect(kept[0]).toEqual(userMsg(goal));
    expect(evicted.length).toBeGreaterThan(0);
  });

  it("keeps newest messages first when budget is tight", () => {
    const history = [
      userMsg("goal"),
      assistantMsg("old-step"),
      toolMsg("old-result"),
      assistantMsg("new-step"),
      toolMsg("new-result"),
    ];
    // Very tight budget — only fits goal + last two messages.
    const { kept, evicted: _evicted } = selectRecentTurns(history, 30);
    expect(kept).toContainEqual(userMsg("goal"));
    // Newer messages should be kept over older ones.
    const keptContents = kept.map((m) => m.content);
    expect(keptContents).toContain("new-step");
    expect(keptContents).toContain("new-result");
  });

  it("evicts oldest messages when budget is exceeded", () => {
    const history = [
      userMsg("goal"),
      assistantMsg("old"),
      toolMsg("old-result"),
      assistantMsg("recent"),
      toolMsg("recent-result"),
    ];
    const budget = 500; // chars-based, should keep only recent messages
    const { kept, evicted } = selectRecentTurns(history, budget);
    // Evicted items should not appear in kept.
    for (const ev of evicted) {
      expect(kept).not.toContainEqual(ev);
    }
    // All messages accounted for.
    expect(kept.length + evicted.length).toBe(history.length);
  });
});

// ---------------------------------------------------------------------------
// computePrefixHash
// ---------------------------------------------------------------------------

describe("computePrefixHash", () => {
  it("produces the same hash for identical inputs", () => {
    const tools = [{ name: "myTool", description: "desc", inputSchema: { type: "object" } }];
    const h1 = computePrefixHash(SYSTEM, tools);
    const h2 = computePrefixHash(SYSTEM, tools);
    expect(h1).toBe(h2);
  });

  it("produces different hash when system prompt changes", () => {
    const h1 = computePrefixHash("prompt A", NO_TOOLS);
    const h2 = computePrefixHash("prompt B", NO_TOOLS);
    expect(h1).not.toBe(h2);
  });

  it("produces different hash when tool schema changes", () => {
    const tools1 = [{ name: "t1", description: "d", inputSchema: { type: "object" } }];
    const tools2 = [{ name: "t2", description: "d", inputSchema: { type: "object" } }];
    const h1 = computePrefixHash(SYSTEM, tools1);
    const h2 = computePrefixHash(SYSTEM, tools2);
    expect(h1).not.toBe(h2);
  });

  it("returns an 8-char hex string", () => {
    const h = computePrefixHash(SYSTEM, NO_TOOLS);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// ContextHydrator.build
// ---------------------------------------------------------------------------

describe("ContextHydrator", () => {
  const hydrator = new ContextHydrator();

  it("always includes the system message first", () => {
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [userMsg("goal")],
      facts: [],
      summaries: [],
    });
    expect(result.messages[0]).toEqual({ role: "system", content: SYSTEM });
  });

  it("returns no evicted messages when history fits in budget", () => {
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [userMsg("goal"), assistantMsg("step"), toolMsg("result")],
      facts: [],
      summaries: [],
    });
    expect(result.evictedMessages).toHaveLength(0);
    expect(result.metadata.evictedCount).toBe(0);
  });

  it("injects a facts section when facts are provided", () => {
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [userMsg("goal")],
      facts: [{ key: "user", value: "Alice" }],
      summaries: [],
    });
    const msgs = result.messages;
    const factMsg = msgs.find(
      (m) => m.role === "system" && m.content?.includes("Persistent Facts"),
    );
    expect(factMsg).toBeDefined();
    expect(factMsg?.content).toContain("user: Alice");
  });

  it("injects a summaries section when summaries are provided", () => {
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [userMsg("goal")],
      facts: [],
      summaries: [
        {
          id: "s1",
          fromSeq: 1,
          toSeq: 5,
          content: "User asked about pricing.",
          messageCount: 4,
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    const msgs = result.messages;
    const sumMsg = msgs.find(
      (m) => m.role === "system" && m.content?.includes("Conversation Summary"),
    );
    expect(sumMsg).toBeDefined();
    expect(sumMsg?.content).toContain("User asked about pricing.");
  });

  it("strips system messages from history (does not duplicate them)", () => {
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [{ role: "system", content: "old system" }, userMsg("goal")],
      facts: [],
      summaries: [],
    });
    // Only one system message: the one the hydrator injects.
    const systemMsgs = result.messages.filter((m) => m.role === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0]?.content).toBe(SYSTEM);
  });

  it("evicts old messages when budget is tight, keeping the goal", () => {
    // Use a very tight budget: only ~3 tokens for recent turns.
    const tightBudget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      recentTurnsTokens: 3,
    };
    const history = [userMsg("goal"), assistantMsg("a".repeat(200)), toolMsg("b".repeat(200))];
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history,
      facts: [],
      summaries: [],
      budget: tightBudget,
    });
    // Goal message must always appear in the final list.
    expect(result.messages.some((m) => m.content === "goal")).toBe(true);
    // Some messages were evicted.
    expect(result.evictedMessages.length).toBeGreaterThan(0);
    expect(result.metadata.evictedCount).toBe(result.evictedMessages.length);
  });

  it("reports correct token counts per section", () => {
    const result = hydrator.build({
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [userMsg("goal")],
      facts: [],
      summaries: [],
    });
    const { tokensBySection, totalTokens } = result.metadata;
    expect(tokensBySection.system).toBeGreaterThan(0);
    expect(tokensBySection.facts).toBe(0);
    expect(tokensBySection.summaries).toBe(0);
    expect(tokensBySection.recentTurns).toBeGreaterThan(0);
    expect(totalTokens).toBe(
      tokensBySection.system +
        tokensBySection.facts +
        tokensBySection.summaries +
        tokensBySection.recentTurns,
    );
  });

  it("prefix hash is identical between builds with same system + tools", () => {
    const input = {
      systemPrompt: SYSTEM,
      tools: NO_TOOLS,
      history: [userMsg("goal")] as ModelMessage[],
      facts: [] as const,
      summaries: [] as const,
    };
    const r1 = hydrator.build(input);
    const r2 = hydrator.build({ ...input, history: [userMsg("goal"), assistantMsg("step1")] });
    // History changed, but system + tools did not → same prefix hash.
    expect(r1.metadata.prefixHash).toBe(r2.metadata.prefixHash);
  });

  it("prefix hash changes when system prompt changes", () => {
    const r1 = hydrator.build({
      systemPrompt: "prompt A",
      tools: NO_TOOLS,
      history: [userMsg("goal")],
      facts: [],
      summaries: [],
    });
    const r2 = hydrator.build({
      systemPrompt: "prompt B",
      tools: NO_TOOLS,
      history: [userMsg("goal")],
      facts: [],
      summaries: [],
    });
    expect(r1.metadata.prefixHash).not.toBe(r2.metadata.prefixHash);
  });
});

// ---------------------------------------------------------------------------
// Context size bounded — 200-turn simulation
// ---------------------------------------------------------------------------

describe("ContextHydrator — 200-turn simulation", () => {
  it("keeps total context tokens under budget for a long workflow", () => {
    const hydrator = new ContextHydrator();
    const budget: ContextBudget = {
      systemTokens: 500,
      factsTokens: 200,
      summariesTokens: 1_000,
      recentTurnsTokens: 2_000,
      summarizationThreshold: 5,
    };

    // Build a 200-turn history (user + assistant + tool per turn = 3 messages).
    const history: ModelMessage[] = [userMsg("initial task goal")];
    for (let i = 0; i < 200; i++) {
      history.push(assistantMsg(`Step ${i}: calling a tool with some reasoning text.`));
      history.push(toolMsg(`Tool result ${i}: some data that was computed.`));
    }

    const result = hydrator.build({
      systemPrompt: "You are a helpful assistant.",
      tools: NO_TOOLS,
      history,
      facts: [],
      summaries: [],
      budget,
    });

    const maxAllowedTokens =
      budget.systemTokens + budget.factsTokens + budget.summariesTokens + budget.recentTurnsTokens;

    expect(result.metadata.totalTokens).toBeLessThanOrEqual(maxAllowedTokens);
    // Goal message still present.
    expect(result.messages.some((m) => m.content === "initial task goal")).toBe(true);
  });
});
