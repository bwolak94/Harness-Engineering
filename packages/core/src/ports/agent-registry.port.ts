// ---------------------------------------------------------------------------
// AgentRegistryPort — registry of specialist agents (T10)
// ---------------------------------------------------------------------------

/**
 * AgentSpec — description of a specialist agent and the tools it may use.
 *
 * Least-privilege design: each agent exposes only the tools it needs.
 * A specialist seeing 2–3 tools picks the right one more reliably than a
 * generalist seeing all eleven.
 */
export interface AgentSpec {
  /** Unique machine-readable name used as routing target and event payload. */
  name: string;
  /** Human-readable description shown to the LLM classifier during routing. */
  description: string;
  /** Subset of TOOL_REGISTRY names this agent is allowed to call. */
  toolNames: readonly string[];
}

/**
 * AgentRegistryPort — read-only registry of available specialist agents.
 */
export interface AgentRegistryPort {
  /** Returns the spec for a named agent, or undefined if not registered. */
  get(name: string): AgentSpec | undefined;
  /** Returns all registered agents in stable order. */
  list(): readonly AgentSpec[];
}
