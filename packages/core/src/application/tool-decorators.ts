import type { z } from "zod";
import { err } from "../domain/result.js";
import type { ToolCallError, ToolExecutor } from "../ports/tool-registry.port.js";
import type { ToolPolicy } from "./tool-policy.js";
import { truncateResult } from "./truncation.js";

/**
 * ToolExecutorDecorator — a function that wraps a ToolExecutor in another.
 *
 * Decorators are composable: apply them left-to-right via functional composition.
 * Recommended order: withPolicy → withValidation → withTimeout → withResultTruncation → withTelemetry
 */
export type ToolExecutorDecorator = (executor: ToolExecutor) => ToolExecutor;

/** Compose multiple decorators left-to-right (first = outermost). */
export function composeDecorators(...decorators: ToolExecutorDecorator[]): ToolExecutorDecorator {
  return (executor) => decorators.reduceRight((acc, dec) => dec(acc), executor);
}

// ---------------------------------------------------------------------------
// withValidation — schema-first argument validation
// ---------------------------------------------------------------------------

/**
 * withValidation — parse `args` against the Zod schema before forwarding to
 * the inner executor. Returns a structured ToolCallError on parse failure.
 *
 * The error message is intentionally written FOR THE MODEL, not for a developer
 * log: it includes field paths and Zod messages so the model can self-correct.
 */
export function withValidation<TInput>(schema: z.ZodType<TInput>): ToolExecutorDecorator {
  return (executor) => ({
    definition: executor.definition,
    execute: async (args, signal) => {
      const result = schema.safeParse(args);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  • ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
          .join("\n");
        const callError: ToolCallError = {
          code: "VALIDATION_ERROR",
          message: `Tool '${executor.definition.name}' received invalid arguments.\nValidation errors:\n${issues}\nPlease correct the argument structure and try again.`,
          hint: `Use the tool's schema definition to verify the required fields and their types.`,
          retryable: false,
        };
        return err(callError);
      }
      return executor.execute(result.data as unknown, signal);
    },
  });
}

// ---------------------------------------------------------------------------
// withTimeout — cooperative cancellation via AbortSignal
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(toolName: string, ms: number) {
    super(`${toolName} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * withTimeout — wrap execution in a race between the tool and a timer.
 *
 * Fires `AbortController.abort()` when the timer expires, forwarding the signal
 * to the inner executor so long-running tools can cooperate. Also races the
 * execution against a rejecting timeout promise to guarantee termination.
 *
 * Note: if the inner tool does not honour AbortSignal, the `execute` call will
 * be "floating" after timeout. Pure-computation tools are safe; I/O tools must
 * implement signal handling.
 */
export function withTimeout(ms: number): ToolExecutorDecorator {
  return (executor) => ({
    definition: executor.definition,
    execute: async (args, parentSignal) => {
      const controller = new AbortController();

      // Forward parent abort to our controller
      if (parentSignal) {
        parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      let timerHandle: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timerHandle = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(executor.definition.name, ms));
        }, ms);
      });

      try {
        const result = await Promise.race([
          executor.execute(args, controller.signal),
          timeoutPromise,
        ]);
        return result;
      } catch (e) {
        if (e instanceof TimeoutError) {
          const callError: ToolCallError = {
            code: "TIMEOUT",
            message: `Tool '${executor.definition.name}' did not respond within ${ms}ms. Try simplifying the input or reducing the scope.`,
            hint: `This tool has a ${ms}ms time limit. Reduce input complexity.`,
            retryable: true,
          };
          return err(callError);
        }
        throw e;
      } finally {
        clearTimeout(timerHandle);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// withPolicy — Specification-based access control
// ---------------------------------------------------------------------------

/**
 * withPolicy — evaluate the policy before forwarding to the inner executor.
 *
 * "allow"          → forward to inner executor.
 * "deny"           → return ToolCallError immediately.
 * "requireApproval"→ return ToolCallError with code APPROVAL_REQUIRED
 *                     (T12 will intercept this and suspend the workflow).
 */
export function withPolicy(policy: ToolPolicy): ToolExecutorDecorator {
  return (executor) => ({
    definition: executor.definition,
    execute: async (args, signal) => {
      const decision = policy.evaluate(args, executor.definition);

      if (decision === "deny") {
        const callError: ToolCallError = {
          code: "POLICY_DENIED",
          message: `Tool '${executor.definition.name}' is not permitted by the current policy.`,
          hint: "Use a different tool or request the operation through the appropriate channel.",
          retryable: false,
        };
        return err(callError);
      }

      if (decision === "requireApproval") {
        const callError: ToolCallError = {
          code: "APPROVAL_REQUIRED",
          message: `Tool '${executor.definition.name}' requires human approval before it can be executed.`,
          hint: "The workflow will be suspended until a human approves or rejects this action.",
          retryable: false,
        };
        return err(callError);
      }

      return executor.execute(args, signal);
    },
  });
}

// ---------------------------------------------------------------------------
// withResultTruncation — keep context window manageable
// ---------------------------------------------------------------------------

/**
 * withResultTruncation — cap the serialised result size.
 *
 * Uses structure-preserving head+tail truncation so the model always sees both
 * the beginning and end of the response. The truncation marker is included in
 * the result so the model knows data was omitted.
 *
 * @param maxChars - Maximum character budget for the serialised result.
 */
export function withResultTruncation(maxChars: number): ToolExecutorDecorator {
  return (executor) => ({
    definition: executor.definition,
    execute: async (args, signal) => {
      const result = await executor.execute(args, signal);
      if (!result.ok) return result;

      const truncated = truncateResult(result.value, maxChars);
      // Return the truncated string as the result value.
      // The model receives JSON text it can parse or display.
      return { ok: true as const, value: truncated };
    },
  });
}

// ---------------------------------------------------------------------------
// withTelemetry — lightweight structured timing (placeholder for T13)
// ---------------------------------------------------------------------------

/**
 * withTelemetry — logs execution timing to console.debug (placeholder).
 * T13 replaces this with full OTel span instrumentation without changing
 * the tool or decorator chain.
 */
export function withTelemetry(label?: string): ToolExecutorDecorator {
  return (executor) => ({
    definition: executor.definition,
    execute: async (args, signal) => {
      const name = label ?? executor.definition.name;
      const start = Date.now();
      const result = await executor.execute(args, signal);
      const durationMs = Date.now() - start;
      console.debug(`[telemetry] ${name} completed in ${durationMs}ms ok=${result.ok}`);
      return result;
    },
  });
}
