// ---------------------------------------------------------------------------
// RouterPort — Chain of Responsibility for intent-to-agent routing (T10)
// ---------------------------------------------------------------------------

import type { AgentSpec } from "./agent-registry.port.js";

/**
 * RoutingDecision — the result of classifying an incoming intent.
 *
 * matchedBy signals how the decision was reached:
 *   "rule"       — a deterministic keyword rule committed (zero LLM calls).
 *   "llm"        — a model classifier committed after rules passed.
 *   "escalation" — no classifier reached sufficient confidence; the workflow
 *                  should be suspended for human review (T12).
 */
export interface RoutingDecision {
  /** Name of the specialist agent to route to. Empty string for "escalation". */
  targetAgent: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Human-readable explanation stored in the agent.handoff event. */
  reason: string;
  matchedBy: "rule" | "llm" | "escalation";
}

/**
 * RouterLink — a single link in the Chain of Responsibility.
 *
 * Returns a RoutingDecision when it can classify with sufficient confidence,
 * or null to pass control to the next link.
 *
 * Pattern: Chain of Responsibility — each link is independent and testable.
 * The chain is: RuleBasedClassifier → LlmClassifier → EscalationClassifier.
 * Cost increases along the chain; LLM is only called when rules fail.
 */
export interface RouterLink {
  classify(intent: string, agents: readonly AgentSpec[]): Promise<RoutingDecision | null>;
}

/**
 * RouterPort — top-level routing interface.
 *
 * Accepts a natural-language intent and returns the routing decision.
 * The optional RoutingGuard is passed in by the caller to enforce hop limits
 * and cycle detection across multiple sequential route() calls.
 */
export interface RouterPort {
  route(intent: string): Promise<RoutingDecision>;
}
