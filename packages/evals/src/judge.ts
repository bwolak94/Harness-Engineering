import type { HarnessEvent } from "@harness/contracts";
import type { WorkflowState } from "@harness/core";
import type {
  OutcomeCheck,
  OutcomeFailure,
  TrajectoryConstraint,
  TrajectoryFailure,
} from "./types.js";

// ---------------------------------------------------------------------------
// Path navigation
// ---------------------------------------------------------------------------

/**
 * Navigate a nested object using dot-path notation.
 * Returns undefined if any segment is missing.
 * Supports array length shorthand: "assumptions.length" → array.length.
 */
export function getNestedValue(obj: unknown, path: DotPath): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (part === "length" && Array.isArray(current)) return current.length;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

type DotPath = string;

// ---------------------------------------------------------------------------
// Outcome judge
// ---------------------------------------------------------------------------

/**
 * Run one outcome check against a tool result object.
 * Returns a failure description or null on pass.
 */
export function runOutcomeCheck(result: unknown, check: OutcomeCheck): OutcomeFailure | null {
  const value = getNestedValue(result, check.path);

  switch (check.type) {
    case "field_gt": {
      if (typeof value !== "number" || value <= check.value) {
        return {
          check,
          message: `Expected ${check.path} > ${check.value}, got ${JSON.stringify(value)}`,
        };
      }
      return null;
    }
    case "field_lt": {
      if (typeof value !== "number" || value >= check.value) {
        return {
          check,
          message: `Expected ${check.path} < ${check.value}, got ${JSON.stringify(value)}`,
        };
      }
      return null;
    }
    case "field_between": {
      if (typeof value !== "number" || value < check.min || value > check.max) {
        return {
          check,
          message: `Expected ${check.path} in [${check.min}, ${check.max}], got ${JSON.stringify(value)}`,
        };
      }
      return null;
    }
    case "field_equals": {
      if (JSON.stringify(value) !== JSON.stringify(check.value)) {
        return {
          check,
          message: `Expected ${check.path} = ${JSON.stringify(check.value)}, got ${JSON.stringify(value)}`,
        };
      }
      return null;
    }
    case "array_min_length": {
      const len = Array.isArray(value)
        ? value.length
        : getNestedValue(result, `${check.path}.length`);
      if (typeof len !== "number" || len < check.minLength) {
        return {
          check,
          message: `Expected ${check.path}.length >= ${check.minLength}, got ${JSON.stringify(len)}`,
        };
      }
      return null;
    }
    case "field_truthy": {
      if (!value) {
        return {
          check,
          message: `Expected ${check.path} to be truthy, got ${JSON.stringify(value)}`,
        };
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Trajectory judge
// ---------------------------------------------------------------------------

/**
 * Run one trajectory constraint against the event log and final state.
 * Returns a failure description or null on pass.
 */
export function runTrajectoryCheck(
  events: readonly HarnessEvent[],
  state: WorkflowState,
  constraint: TrajectoryConstraint,
): TrajectoryFailure | null {
  switch (constraint.type) {
    case "status": {
      if (state.status !== constraint.expected) {
        return {
          constraint,
          message: `Expected status ${constraint.expected}, got ${state.status}`,
        };
      }
      return null;
    }
    case "max_steps": {
      const steps = events.filter((e) => e.type === "tool.called").length;
      if (steps > constraint.max) {
        return {
          constraint,
          message: `Expected at most ${constraint.max} steps, got ${steps}`,
        };
      }
      return null;
    }
    case "min_steps": {
      const steps = events.filter((e) => e.type === "tool.called").length;
      if (steps < constraint.min) {
        return {
          constraint,
          message: `Expected at least ${constraint.min} steps, got ${steps}`,
        };
      }
      return null;
    }
    case "tool_called": {
      const called = events.some(
        (e) =>
          e.type === "tool.called" &&
          (e.payload as { toolName?: string }).toolName === constraint.name,
      );
      if (!called) {
        return {
          constraint,
          message: `Expected tool '${constraint.name}' to be called, but it was not`,
        };
      }
      return null;
    }
    case "tool_not_called": {
      const called = events.some(
        (e) =>
          e.type === "tool.called" &&
          (e.payload as { toolName?: string }).toolName === constraint.name,
      );
      if (called) {
        return {
          constraint,
          message: `Expected tool '${constraint.name}' NOT to be called, but it was`,
        };
      }
      return null;
    }
    case "no_repeated_tool_args": {
      const seen = new Set<string>();
      for (const e of events) {
        if (e.type !== "tool.called") continue;
        const { toolName, args } = e.payload as { toolName?: string; args?: unknown };
        const key = JSON.stringify({ toolName, args });
        if (seen.has(key)) {
          return {
            constraint,
            message: `Tool '${toolName}' was called with identical args more than once (loop detected)`,
          };
        }
        seen.add(key);
      }
      return null;
    }
  }
}
