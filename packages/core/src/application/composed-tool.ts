// ---------------------------------------------------------------------------
// Composed Tool ("Macro Tool") — chain existing tools via a JSON spec.
//
// Pattern: Composite / Macro
// A ComposedToolSpec describes a sequence of tool calls where each step's
// input is resolved from the original workflow input or a previous step's
// output via lightweight template expressions.
//
// Template syntax:
//   {{input.field.nested}}    — resolved from the workflow input
//   {{steps[N].field.nested}} — resolved from step N's output (0-indexed)
//
// Cycle detection (validateComposedToolSpec):
//   A composed tool may reference other composed tools. Cycles are detected
//   via DFS over the known composed spec registry and rejected at save time.
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "@harness/contracts";
import type { Result } from "../domain/result.js";
import { err, ok } from "../domain/result.js";
import type { ToolCallError, ToolExecutor, ToolRegistryPort } from "../ports/tool-registry.port.js";

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export interface ComposedToolChainStep {
  /** Name of the tool to invoke. Must exist in the ToolRegistry at call time. */
  tool: string;
  /**
   * Maps each input field of the target tool from workflow input or previous
   * step output using template expressions.
   *
   * Key:   field name expected by the target tool
   * Value: template string, e.g. "{{input.userId}}" or "{{steps[0].id}}"
   *
   * If omitted, the raw workflow input is forwarded as-is to the step.
   */
  inputMapping?: Record<string, string>;
}

export interface ComposedToolSpec {
  /** Unique tool identifier — becomes the registered ToolExecutor name. */
  name: string;
  /** Human-readable description for the model context. */
  description: string;
  /** Ordered list of tool invocations. Must have at least one entry. */
  chain: readonly ComposedToolChainStep[];
  /** Mark true when re-running with identical inputs is safe. */
  idempotent?: boolean;
  /** Mark true to flag this tool in policy checks. */
  dangerous?: boolean;
}

// ---------------------------------------------------------------------------
// Static validation (called at save time)
// ---------------------------------------------------------------------------

/**
 * Validate a ComposedToolSpec before registering or persisting it.
 *
 * Checks:
 * - chain is non-empty
 * - no composed tool directly or transitively calls itself (DFS cycle detection)
 *
 * @param spec         - The spec to validate.
 * @param knownComposed - Registry of already-registered composed specs keyed by name.
 *                       Used for transitive cycle detection.
 */
export function validateComposedToolSpec(
  spec: ComposedToolSpec,
  knownComposed: ReadonlyMap<string, ComposedToolSpec> = new Map(),
): void {
  if (spec.chain.length === 0) {
    throw new Error(`ComposedTool '${spec.name}' must have at least one chain step.`);
  }

  // DFS cycle detection: collect tool names reachable from this spec.
  // visiting = set of names currently on the DFS stack (for cycle detection)
  const visiting = new Set<string>([spec.name]);

  function dfs(current: ComposedToolSpec): void {
    for (const step of current.chain) {
      if (step.tool === spec.name || visiting.has(step.tool)) {
        throw new Error(`ComposedTool '${spec.name}' contains a cycle involving '${step.tool}'.`);
      }
      const nested = knownComposed.get(step.tool);
      if (nested) {
        visiting.add(step.tool);
        dfs(nested);
        visiting.delete(step.tool);
      }
    }
  }

  dfs(spec);
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single template expression against the current execution context.
 *
 * Supported forms:
 *   {{input.a.b}}      — nested path into `workflowInput`
 *   {{steps[N].a.b}}   — nested path into `stepOutputs[N]`
 *
 * Returns `undefined` when the path does not exist.
 */
function resolveTemplate(
  template: string,
  workflowInput: Record<string, unknown>,
  stepOutputs: unknown[],
): unknown {
  const trimmed = template.trim();

  // Pure template: the entire value is a single expression → preserve type
  const pureMatch = /^\{\{([^}]+)\}\}$/.exec(trimmed);
  if (pureMatch) {
    return resolvePath(pureMatch[1] ?? "", workflowInput, stepOutputs);
  }

  // Mixed template: substitute all {{…}} occurrences into a string
  return trimmed.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
    const val = resolvePath(expr.trim(), workflowInput, stepOutputs);
    return val !== undefined ? String(val) : "";
  });
}

function resolvePath(
  expr: string,
  workflowInput: Record<string, unknown>,
  stepOutputs: unknown[],
): unknown {
  const stepMatch = /^steps\[(\d+)\](?:\.(.+))?$/.exec(expr);
  if (stepMatch) {
    const idx = Number(stepMatch[1]);
    const rest = stepMatch[2];
    const base = stepOutputs[idx];
    return rest ? dotGet(base, rest) : base;
  }

  if (expr.startsWith("input.")) {
    return dotGet(workflowInput, expr.slice("input.".length));
  }

  if (expr === "input") {
    return workflowInput;
  }

  return undefined;
}

function dotGet(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Build the input object for a single chain step.
 *
 * When `inputMapping` is provided every key is resolved from a template.
 * When `inputMapping` is absent the raw `workflowInput` is forwarded.
 */
function buildStepInput(
  step: ComposedToolChainStep,
  workflowInput: Record<string, unknown>,
  stepOutputs: unknown[],
): unknown {
  if (!step.inputMapping) {
    return workflowInput;
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(step.inputMapping)) {
    resolved[key] = resolveTemplate(template, workflowInput, stepOutputs);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * Create a `ToolExecutor` that runs the composed chain at call time.
 *
 * - Steps execute sequentially; the first failure short-circuits the chain.
 * - The output of the final step is returned as the macro's result.
 * - Tool lookup happens at call time (not at construction time) so the registry
 *   may be populated after the composed tool is registered.
 */
export function createComposedToolExecutor(
  spec: ComposedToolSpec,
  registry: ToolRegistryPort,
): ToolExecutor {
  const definition: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    dangerous: spec.dangerous ?? false,
    idempotent: spec.idempotent ?? false,
    costHint: "moderate",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  };

  return {
    definition,

    async execute(args: unknown, signal?: AbortSignal): Promise<Result<unknown, ToolCallError>> {
      const workflowInput =
        args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};

      const stepOutputs: unknown[] = [];

      for (let i = 0; i < spec.chain.length; i++) {
        const step = spec.chain[i];
        if (!step) continue;

        // Abort early if signal was triggered
        if (signal?.aborted) {
          return err({
            code: "COMPOSED_TOOL_ABORTED",
            message: `ComposedTool '${spec.name}' was aborted at step ${i} ('${step.tool}').`,
            retryable: false,
          });
        }

        const executor = registry.get(step.tool);
        if (!executor) {
          return err({
            code: "COMPOSED_TOOL_MISSING_STEP",
            message: `ComposedTool '${spec.name}' step ${i}: tool '${step.tool}' not found in registry.`,
            retryable: false,
          });
        }

        const stepInput = buildStepInput(step, workflowInput, stepOutputs);
        const result = await executor.execute(stepInput, signal);

        if (!result.ok) {
          return err({
            code: "COMPOSED_TOOL_STEP_FAILED",
            message: `ComposedTool '${spec.name}' step ${i} ('${step.tool}') failed: ${result.error.message}`,
            ...(result.error.hint !== undefined ? { hint: result.error.hint } : {}),
            retryable: result.error.retryable,
          });
        }

        stepOutputs.push(result.value);
      }

      // Return the output of the final step
      const finalOutput = stepOutputs[stepOutputs.length - 1];
      return ok(finalOutput);
    },
  };
}
