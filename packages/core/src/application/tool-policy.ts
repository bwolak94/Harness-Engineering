import type { ToolDefinition } from "@harness/contracts";

/**
 * PolicyDecision — what the policy says about a particular tool invocation.
 *
 * - "allow":          proceed to execution immediately.
 * - "deny":           block execution and return an error to the model.
 * - "requireApproval": suspend and wait for human confirmation (T12).
 */
export type PolicyDecision = "allow" | "deny" | "requireApproval";

/**
 * ToolPolicy — Specification pattern for tool access control.
 *
 * Policies are composable boolean objects:
 *   isDangerous().and(notApproved())    → requireApproval
 *   isBlocklisted().or(isDangerous())  → deny if either is true
 *   isDangerous().not()                → allow only safe tools
 *
 * Rationale: policy conditions are currently scattered if/else chains in the
 * runtime. Extracting them as composable objects (Specification) decouples the
 * "what is the rule" from "where the rule is enforced".
 */
export interface ToolPolicy {
  evaluate(args: unknown, definition: ToolDefinition): PolicyDecision;
  and(other: ToolPolicy): ToolPolicy;
  or(other: ToolPolicy): ToolPolicy;
  not(): ToolPolicy;
}

// ---------------------------------------------------------------------------
// Base implementation
// ---------------------------------------------------------------------------

class CompositePolicy implements ToolPolicy {
  constructor(private readonly fn: (args: unknown, def: ToolDefinition) => PolicyDecision) {}

  evaluate(args: unknown, definition: ToolDefinition): PolicyDecision {
    return this.fn(args, definition);
  }

  and(other: ToolPolicy): ToolPolicy {
    return policy((args, def) => {
      const left = this.evaluate(args, def);
      if (left === "deny") return "deny";
      const right = other.evaluate(args, def);
      if (right === "deny") return "deny";
      if (left === "requireApproval" || right === "requireApproval") return "requireApproval";
      return "allow";
    });
  }

  or(other: ToolPolicy): ToolPolicy {
    return policy((args, def) => {
      const left = this.evaluate(args, def);
      if (left === "allow") return "allow";
      const right = other.evaluate(args, def);
      if (right === "allow") return "allow";
      if (left === "requireApproval" || right === "requireApproval") return "requireApproval";
      return "deny";
    });
  }

  not(): ToolPolicy {
    return policy((args, def) => {
      const decision = this.evaluate(args, def);
      switch (decision) {
        case "allow":
          return "deny";
        case "deny":
          return "allow";
        case "requireApproval":
          return "requireApproval"; // negating approval requirement keeps it pending
      }
    });
  }
}

/** Factory: create a ToolPolicy from an evaluator function. */
export function policy(
  fn: (args: unknown, definition: ToolDefinition) => PolicyDecision,
): ToolPolicy {
  return new CompositePolicy(fn);
}

// ---------------------------------------------------------------------------
// Built-in policy factories
// ---------------------------------------------------------------------------

/** Allow everything unconditionally. Useful as a no-op default. */
export function allowAll(): ToolPolicy {
  return policy(() => "allow");
}

/** Deny everything. Useful in tests or as a "killswitch" override. */
export function denyAll(): ToolPolicy {
  return policy(() => "deny");
}

/**
 * Require human approval for tools marked `dangerous: true`.
 * Combined with `allowAll()` for safe tools: `isDangerous().and(allowAll())` is
 * equivalent to writing `isDangerous()` since `allowAll().not()` covers the rest.
 */
export function isDangerous(): ToolPolicy {
  return policy((_args, def) => (def.dangerous ? "requireApproval" : "allow"));
}

/**
 * Deny any tool whose name is in the blocklist.
 * The error message is written for the model so it can suggest an alternative.
 */
export function denyListed(names: readonly string[]): ToolPolicy {
  const set = new Set(names);
  return policy((_args, def) => (set.has(def.name) ? "deny" : "allow"));
}
