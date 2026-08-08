import type { MemoryFact, MemorySummary } from "../ports/memory-store.port.js";
import type { ModelMessage, ModelToolSchema } from "../ports/model.port.js";
import { estimateTokens } from "./truncation.js";

// ---------------------------------------------------------------------------
// Token budget configuration
// ---------------------------------------------------------------------------

/**
 * ContextBudget — token limits per section of the assembled context.
 *
 * Budget enforcement is approximate (1 token ≈ 4 chars). Each section is
 * truncated independently before assembly so the total stays predictable.
 */
export interface ContextBudget {
  /** Tokens reserved for the system prompt section. */
  systemTokens: number;
  /** Tokens reserved for injected persistent facts. */
  factsTokens: number;
  /** Tokens reserved for conversation summaries. */
  summariesTokens: number;
  /** Tokens reserved for recent conversation turns (sliding window). */
  recentTurnsTokens: number;
  /**
   * Number of evicted messages that triggers summarization.
   * When evictedMessages.length >= this threshold, the Summarizer is called.
   */
  summarizationThreshold: number;
}

/** Sensible defaults — fits comfortably within a 16k context window. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  systemTokens: 1_000,
  factsTokens: 500,
  summariesTokens: 2_000,
  recentTurnsTokens: 8_000,
  summarizationThreshold: 5,
};

// ---------------------------------------------------------------------------
// Hydrator input / output
// ---------------------------------------------------------------------------

export interface HydrationInput {
  /** System prompt (stable — same for every step of a given workflow). */
  systemPrompt: string;
  /** Tool schemas from the registry. Used for prefix hash computation. */
  tools: readonly ModelToolSchema[];
  /**
   * Full conversation history (all messages since workflow.started, excluding
   * system messages — those are reconstructed each turn from systemPrompt).
   */
  history: readonly ModelMessage[];
  /** Persistent facts from MemoryStore. */
  facts: readonly MemoryFact[];
  /** Compressed history summaries from MemoryStore. */
  summaries: readonly MemorySummary[];
  /** Budget to use; falls back to DEFAULT_CONTEXT_BUDGET if omitted. */
  budget?: ContextBudget;
}

export interface TokensBySection {
  system: number;
  facts: number;
  summaries: number;
  recentTurns: number;
}

export interface HydrationMetadata {
  tokensBySection: TokensBySection;
  totalTokens: number;
  /**
   * djb2 hash of (systemPrompt + tool schema JSON).
   * Identical between steps when neither system prompt nor tool set changes.
   * A cache hit at the provider level requires byte-for-byte prefix identity —
   * this hash is the lightweight signal that the prefix is stable.
   */
  prefixHash: string;
  /** Count of history messages that did not fit in recentTurnsTokens. */
  evictedCount: number;
}

export interface HydrationResult {
  /** The pruned message list, ready to pass to ModelPort.generate(). */
  messages: readonly ModelMessage[];
  /**
   * The messages that were evicted from history.
   * HarnessRuntime uses this to decide whether to trigger summarization.
   */
  evictedMessages: readonly ModelMessage[];
  metadata: HydrationMetadata;
}

// ---------------------------------------------------------------------------
// ContextHydrator
// ---------------------------------------------------------------------------

/**
 * ContextHydrator — pure, stateless pipeline that builds a pruned message list.
 *
 * Pipeline order:
 *   1. system message          (stable prefix — always first)
 *   2. facts section           (stable prefix — injected as system context)
 *   3. summaries section       (stable prefix — injected as system context)
 *   4. first user message      (the original task goal — always kept)
 *   5. recent turns            (sliding window from newest backward)
 *
 * The stable prefix (system + facts + summaries) is placed first so that
 * provider prompt caches can match it across consecutive steps.
 *
 * No side effects — does not read from MemoryStore directly, does not emit events.
 * The caller (HarnessRuntime) is responsible for storage and event emission.
 */
export class ContextHydrator {
  build(input: HydrationInput): HydrationResult {
    const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET;

    // --- Section 1: system (stable prefix) ---
    const systemMsg: ModelMessage = { role: "system", content: input.systemPrompt };
    const systemTokens = estimateTokens(input.systemPrompt.length);

    // --- Section 2: facts (stable prefix, injected as system context) ---
    let factsMsg: ModelMessage | null = null;
    let factsTokens = 0;
    if (input.facts.length > 0) {
      const factsContent = formatFacts(input.facts, budget.factsTokens);
      factsMsg = { role: "system", content: factsContent };
      factsTokens = estimateTokens(factsContent.length);
    }

    // --- Section 3: summaries (stable prefix, injected as system context) ---
    let summariesMsg: ModelMessage | null = null;
    let summariesTokens = 0;
    if (input.summaries.length > 0) {
      const summariesContent = formatSummaries(input.summaries, budget.summariesTokens);
      summariesMsg = { role: "system", content: summariesContent };
      summariesTokens = estimateTokens(summariesContent.length);
    }

    // Prefix hash covers system + tool schemas — both stable between steps.
    const prefixHash = computePrefixHash(input.systemPrompt, input.tools);

    // --- Section 4: recent turns (sliding window) ---
    // Strip any system messages from history — we inject our own above.
    const conversationHistory = input.history.filter((m) => m.role !== "system");
    const { kept, evicted } = selectRecentTurns(conversationHistory, budget.recentTurnsTokens);

    const recentTurnsTokens = kept.reduce(
      (sum, m) => sum + estimateTokens((m.content ?? "").length),
      0,
    );

    // --- Assemble ---
    const messages: ModelMessage[] = [systemMsg];
    if (factsMsg !== null) messages.push(factsMsg);
    if (summariesMsg !== null) messages.push(summariesMsg);
    messages.push(...kept);

    const totalTokens = systemTokens + factsTokens + summariesTokens + recentTurnsTokens;

    return {
      messages,
      evictedMessages: evicted,
      metadata: {
        tokensBySection: {
          system: systemTokens,
          facts: factsTokens,
          summaries: summariesTokens,
          recentTurns: recentTurnsTokens,
        },
        totalTokens,
        prefixHash,
        evictedCount: evicted.length,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format facts as a concise system context block.
 * Truncates to the given token budget (1 token ≈ 4 chars).
 */
function formatFacts(facts: readonly MemoryFact[], maxTokens: number): string {
  const lines = facts.map((f) => `${f.key}: ${f.value}`);
  let content = `## Persistent Facts\n${lines.join("\n")}`;
  const maxChars = maxTokens * 4;
  if (content.length > maxChars) {
    content = `${content.slice(0, maxChars)}\n…[truncated]`;
  }
  return content;
}

/**
 * Format summaries as a concise system context block.
 * Truncates to the given token budget.
 */
function formatSummaries(summaries: readonly MemorySummary[], maxTokens: number): string {
  const lines = summaries.map((s) => `[Steps ${s.fromSeq}–${s.toSeq}]: ${s.content}`);
  let content = `## Conversation Summary\n${lines.join("\n\n")}`;
  const maxChars = maxTokens * 4;
  if (content.length > maxChars) {
    content = `${content.slice(0, maxChars)}\n…[truncated]`;
  }
  return content;
}

/**
 * selectRecentTurns — sliding window eviction.
 *
 * Rules:
 *   - The first message (task goal) is always kept.
 *   - Remaining messages are selected newest-first until the budget is exhausted.
 *   - Messages that don't fit are returned as `evicted`.
 *
 * @param history  Conversation messages (system messages already filtered out).
 * @param budgetTokens  Max tokens for the entire recent-turns section.
 */
export function selectRecentTurns(
  history: readonly ModelMessage[],
  budgetTokens: number,
): { kept: ModelMessage[]; evicted: ModelMessage[] } {
  if (history.length === 0) return { kept: [], evicted: [] };

  const maxChars = budgetTokens * 4;

  // The first message (task goal / initial user message) is always kept.
  const first = history[0] as ModelMessage;
  const firstChars = (first.content ?? "").length;

  if (history.length === 1) {
    // Only the goal — fits trivially.
    return { kept: [first], evicted: [] };
  }

  // Walk backward through the remaining messages, keeping newest first.
  const rest = history.slice(1);
  let usedChars = firstChars;
  const toKeep: ModelMessage[] = [];
  const evicted: ModelMessage[] = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i] as ModelMessage;
    const msgChars = (msg.content ?? "").length;
    if (usedChars + msgChars <= maxChars) {
      toKeep.unshift(msg);
      usedChars += msgChars;
    } else {
      evicted.unshift(msg);
    }
  }

  return { kept: [first, ...toKeep], evicted };
}

/**
 * computePrefixHash — djb2 hash of systemPrompt + tool schema JSON.
 *
 * Pure computation — no crypto imports, safe in packages/core.
 * Produces an 8-char hex string. Collisions are acceptable; this is a
 * cache-hit signal, not a security boundary.
 */
export function computePrefixHash(systemPrompt: string, tools: readonly ModelToolSchema[]): string {
  const toolsJson = JSON.stringify(tools.map((t) => ({ name: t.name, schema: t.inputSchema })));
  const raw = systemPrompt + toolsJson;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (((h * 33) >>> 0) ^ (raw.charCodeAt(i) ?? 0)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
