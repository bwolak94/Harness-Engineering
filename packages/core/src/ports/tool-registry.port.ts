import type { ToolDefinition } from "@harness/contracts";
import type { Result } from "../domain/result.js";

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export interface ToolCallError {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

export interface ToolExecutor {
  definition: ToolDefinition;
  /**
   * Execute the tool with the given (untyped) arguments.
   * The optional AbortSignal is provided by withTimeout and should be checked
   * by long-running tools to enable cooperative cancellation.
   */
  execute(args: unknown, signal?: AbortSignal): Promise<Result<unknown, ToolCallError>>;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ToolRegistryPort {
  /** Register a tool. Throws if a tool with the same name is already registered. */
  register(executor: ToolExecutor): void;

  /** Look up a tool by name. Returns undefined if not found. */
  get(name: string): ToolExecutor | undefined;

  /** List all registered tool executors. */
  list(): readonly ToolExecutor[];

  /** Return JSON-Schema-compatible tool definitions for the model context. */
  schemas(): readonly ToolDefinition[];
}
