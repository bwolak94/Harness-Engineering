import type { ToolDefinition } from "@harness/contracts";
import type { z } from "zod";
import { err, ok } from "../domain/result.js";
import type { ToolCallError, ToolExecutor } from "../ports/tool-registry.port.js";

/**
 * Tool<TInput, TOutput> — typed, Zod-backed tool definition.
 *
 * Carries the full Zod schema alongside execute so the rest of the framework
 * can derive JSON Schema, validate arguments, and generate documentation —
 * all from a single source of truth.
 *
 * Usage:
 *   const myTool: Tool<MyInput, MyOutput> = {
 *     definition: { name: "myTool", ... },
 *     inputSchema: MyInputSchema,
 *     execute: async (input, signal) => { ... },
 *   };
 *   registry.register(asExecutor(myTool));
 */
export interface Tool<TInput, TOutput> {
  definition: ToolDefinition;
  /**
   * The third type parameter (Input) is `unknown` rather than `TInput` so that Zod schemas
   * using `.default()` (whose raw input type includes `| undefined`) remain assignable.
   * exactOptionalPropertyTypes makes `T | undefined` incompatible with `T`, which would
   * otherwise reject all schemas with defaulted optional fields.
   * The parse output type (TInput) is still enforced — only the raw input side is relaxed.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Zod schema _input varies when fields have .default()
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;
  execute(input: TInput, signal?: AbortSignal): Promise<TOutput>;
}

/**
 * asExecutor — adapt a typed Tool into an untyped ToolExecutor.
 *
 * The adapter is responsible for:
 * 1. Parsing and validating raw args against the Zod schema.
 * 2. Converting the typed output to the untyped Result boundary.
 * 3. Catching unexpected throws and converting them to ToolCallError.
 *
 * Validation failures are returned as ToolCallErrors with the model-facing
 * message written for the model (not for a developer log), including a hint
 * about the expected schema.
 */
export function asExecutor<TInput, TOutput>(tool: Tool<TInput, TOutput>): ToolExecutor {
  return {
    definition: tool.definition,
    execute: async (args: unknown, signal?: AbortSignal) => {
      const parseResult = tool.inputSchema.safeParse(args);
      if (!parseResult.success) {
        const issues = parseResult.error.issues
          .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        const callError: ToolCallError = {
          code: "VALIDATION_ERROR",
          message: `Tool '${tool.definition.name}' received invalid arguments:\n${issues}`,
          hint: `Check the tool's inputSchema and correct the argument structure.`,
          retryable: false,
        };
        return err(callError);
      }

      try {
        const output = await tool.execute(parseResult.data, signal);
        return ok(output as unknown);
      } catch (e) {
        const callError: ToolCallError = {
          code: "EXECUTION_ERROR",
          message: `Tool '${tool.definition.name}' threw an unexpected error: ${String(e)}`,
          retryable: false,
        };
        return err(callError);
      }
    },
  };
}
