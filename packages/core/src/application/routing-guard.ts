// ---------------------------------------------------------------------------
// RoutingGuard — hop-limit enforcement and cycle detection (T10)
//
// Pattern: the same mechanism as LoopDetector (T02) applied at the routing
// level — one guard per workflow, call record() after each routing decision.
// ---------------------------------------------------------------------------

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: "hop_limit_exceeded" | "cycle_detected"; path: readonly string[] };

/**
 * RoutingGuard — stateful per-workflow guard against routing pathologies.
 *
 * Two failure modes:
 *   1. Cycle (A → B → A): visiting an already-visited agent is always rejected.
 *   2. Hop limit: more than `maxHops` agents visited in a single workflow run.
 *
 * Usage:
 *   const guard = new RoutingGuard();
 *   const r1 = guard.record("financial-analyst"); // r1.ok === true
 *   const r2 = guard.record("commercial-analyst"); // r2.ok === true
 *   const r3 = guard.record("financial-analyst");  // r3.ok === false, "cycle_detected"
 */
export class RoutingGuard {
  private readonly visited: string[] = [];

  /**
   * @param maxHops Maximum number of agents that may be visited (default 5).
   *                Exceeding this limit returns "hop_limit_exceeded".
   */
  constructor(private readonly maxHops: number = 5) {}

  /**
   * Record a routing step to the given agent and check for violations.
   * Call this immediately after the Router returns a non-escalation decision.
   */
  record(agentName: string): GuardResult {
    // Cycle: this agent was already visited earlier in the same workflow.
    if (this.visited.includes(agentName)) {
      return {
        ok: false,
        reason: "cycle_detected",
        path: [...this.visited, agentName],
      };
    }

    // Hop limit: too many distinct agents visited.
    if (this.visited.length >= this.maxHops) {
      return {
        ok: false,
        reason: "hop_limit_exceeded",
        path: [...this.visited, agentName],
      };
    }

    this.visited.push(agentName);
    return { ok: true };
  }

  /** Number of agents visited so far (including the current one). */
  get hopCount(): number {
    return this.visited.length;
  }

  /** Ordered list of agents visited in this workflow run. */
  get path(): readonly string[] {
    return this.visited;
  }
}
