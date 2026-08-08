// ---------------------------------------------------------------------------
// Router — Chain of Responsibility for intent-to-agent routing (T10)
//
// Chain order: RuleBasedClassifier → LlmClassifier → EscalationClassifier
//
// Each link returns a RoutingDecision (commits) or null (passes to next link).
// Cost increases along the chain: rules are free, LLM is expensive.
// ---------------------------------------------------------------------------

import type { AgentRegistryPort, AgentSpec } from "../ports/agent-registry.port.js";
import type { ModelPort } from "../ports/model.port.js";
import type { RouterLink, RouterPort, RoutingDecision } from "../ports/router.port.js";
import { selectRecentTurns } from "./context-hydrator.js";
import type { ModelMessage } from "../ports/model.port.js";
import type { RoutingGuard } from "./routing-guard.js";

/** Minimum score fraction for a rule-based classifier to commit. */
export const RULE_CONFIDENCE_THRESHOLD = 0.7;

/** Minimum LLM-reported confidence for the LLM classifier to commit. */
export const LLM_CONFIDENCE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// RuleBasedClassifier
// ---------------------------------------------------------------------------

/**
 * RuleBasedClassifier — RouterLink that matches intents via keyword rules.
 *
 * Scoring: for each agent, count how many of its keywords appear in the intent.
 * The winning agent is the one that accounts for >= RULE_CONFIDENCE_THRESHOLD
 * of ALL matched keywords across agents. Ambiguous intents (keywords spread
 * across multiple agents) fall through to the LLM classifier.
 *
 * Cost: O(agents × keywords), sub-millisecond. Zero LLM calls.
 */
export class RuleBasedClassifier implements RouterLink {
  constructor(
    private readonly rules: ReadonlyMap<string, readonly string[]>,
    private readonly confidenceThreshold = RULE_CONFIDENCE_THRESHOLD,
  ) {}

  async classify(intent: string, agents: readonly AgentSpec[]): Promise<RoutingDecision | null> {
    const lower = intent.toLowerCase();
    const scores = new Map<string, number>();

    for (const agent of agents) {
      const keywords = this.rules.get(agent.name) ?? [];
      const matched = keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
      if (matched > 0) {
        scores.set(agent.name, matched);
      }
    }

    if (scores.size === 0) return null; // No keywords matched — pass to LLM

    const totalMatched = [...scores.values()].reduce((a, b) => a + b, 0);
    const [bestAgent, bestCount] = [...scores.entries()].reduce((best, cur) =>
      cur[1] > best[1] ? cur : best,
    );
    const confidence = bestCount / totalMatched;

    if (confidence < this.confidenceThreshold) {
      return null; // Ambiguous — too many keywords spread across agents
    }

    return {
      targetAgent: bestAgent,
      confidence,
      reason: `Intent matched ${bestCount} of ${totalMatched} total keywords for agent '${bestAgent}'`,
      matchedBy: "rule",
    };
  }
}

// ---------------------------------------------------------------------------
// LlmClassifier
// ---------------------------------------------------------------------------

/**
 * LlmClassifier — RouterLink that asks the model to classify ambiguous intents.
 *
 * The model receives the list of available agents with their descriptions and
 * tools, and returns a JSON blob with the chosen agent and its confidence.
 * If confidence < LLM_CONFIDENCE_THRESHOLD the classifier returns null so the
 * EscalationClassifier can handle it.
 */
export class LlmClassifier implements RouterLink {
  constructor(
    private readonly model: ModelPort,
    private readonly confidenceThreshold = LLM_CONFIDENCE_THRESHOLD,
  ) {}

  async classify(intent: string, agents: readonly AgentSpec[]): Promise<RoutingDecision | null> {
    const agentList = agents
      .map((a) => `- ${a.name}: ${a.description} (tools: ${a.toolNames.join(", ")})`)
      .join("\n");

    const prompt =
      `You are a routing assistant. Select the most appropriate specialist agent for the given intent.\n\n` +
      `Available agents:\n${agentList}\n\n` +
      `User intent: "${intent}"\n\n` +
      `Respond with JSON only, no markdown:\n` +
      `{"agent":"<agent_name>","confidence":<0.0-1.0>,"reason":"<brief explanation>"}`;

    const result = await this.model.generate({
      messages: [{ role: "user", content: prompt }],
      tools: [],
      workflowId: "router",
      taskId: "router",
    });

    if (!result.ok) return null;

    let parsed: { agent?: string; confidence?: number; reason?: string };
    try {
      parsed = JSON.parse(result.value.content ?? "{}") as typeof parsed;
    } catch {
      return null;
    }

    const agentName = parsed.agent;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;

    if (!agentName || !agents.some((a) => a.name === agentName)) return null;
    if (confidence < this.confidenceThreshold) return null;

    return {
      targetAgent: agentName,
      confidence,
      reason: parsed.reason ?? "LLM classification",
      matchedBy: "llm",
    };
  }
}

// ---------------------------------------------------------------------------
// EscalationClassifier
// ---------------------------------------------------------------------------

/**
 * EscalationClassifier — terminal RouterLink that always commits.
 *
 * Reached only when all upstream classifiers returned null (insufficient
 * confidence). Returns an "escalation" decision with empty targetAgent.
 * The caller should treat this as a signal to suspend the workflow for human
 * review (implemented in T12).
 */
export class EscalationClassifier implements RouterLink {
  async classify(_intent: string, _agents: readonly AgentSpec[]): Promise<RoutingDecision> {
    return {
      targetAgent: "",
      confidence: 0,
      reason:
        "No classifier reached sufficient confidence; human review required before routing.",
      matchedBy: "escalation",
    };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Router — orchestrates the Chain of Responsibility.
 *
 * Accepts an optional RoutingGuard; when provided, it is applied AFTER
 * classification to enforce hop limits and detect cycles. A guard violation
 * overrides the decision with an "escalation" so the caller sees a consistent
 * interface.
 *
 * Pattern: Chain of Responsibility (links) + Strategy (each link is swappable
 * and comparable in evals).
 */
export class Router implements RouterPort {
  constructor(
    private readonly links: readonly RouterLink[],
    private readonly registry: AgentRegistryPort,
    private readonly guard?: RoutingGuard,
  ) {}

  async route(intent: string): Promise<RoutingDecision> {
    const agents = this.registry.list();
    let decision: RoutingDecision | null = null;

    for (const link of this.links) {
      const result = await link.classify(intent, agents);
      if (result !== null) {
        decision = result;
        break;
      }
    }

    // Fallback — should never happen if EscalationClassifier is the last link.
    if (decision === null) {
      decision = {
        targetAgent: "",
        confidence: 0,
        reason: "Router has no links configured.",
        matchedBy: "escalation",
      };
    }

    // Apply guard only for non-escalation decisions (there is a real target agent).
    if (this.guard && decision.matchedBy !== "escalation" && decision.targetAgent !== "") {
      const guardResult = this.guard.record(decision.targetAgent);
      if (!guardResult.ok) {
        const description =
          guardResult.reason === "cycle_detected"
            ? `Routing cycle detected: ${guardResult.path.join(" → ")}`
            : `Hop limit exceeded after visiting ${guardResult.path.length - 1} agents`;
        return {
          targetAgent: "",
          confidence: 0,
          reason: description,
          matchedBy: "escalation",
        };
      }
    }

    return decision;
  }
}

// ---------------------------------------------------------------------------
// buildContextSlice
// ---------------------------------------------------------------------------

/**
 * buildContextSlice — return a token-bounded subset of conversation history
 * to pass to the receiving agent during a handoff.
 *
 * Always includes the first message (the original task goal). Fills from the
 * newest messages backward. The result is always smaller than or equal to the
 * full history — passing the full history would be context copy, not handoff.
 *
 * Reuses selectRecentTurns from ContextHydrator (same budget logic, no duplication).
 */
export function buildContextSlice(
  messages: readonly ModelMessage[],
  maxTokenBudget: number,
): readonly ModelMessage[] {
  const { kept } = selectRecentTurns([...messages], maxTokenBudget);
  return kept;
}
