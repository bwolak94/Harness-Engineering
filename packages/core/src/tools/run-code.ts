import type { ToolDefinition } from "@harness/contracts";
import { z } from "zod";
import type { Tool } from "../application/tool.js";
import { NoopSandbox, type SandboxPort } from "../ports/sandbox.port.js";

// ---------------------------------------------------------------------------
// runCode — execute a code snippet in the sandbox
//
// The model uses this tool to write custom computation when domain tools are
// insufficient (e.g. modifying the consumption profile for simulatePVPayback,
// or implementing a custom cost function for optimizeRoute).
//
// Structured errors are returned as tool output (not exceptions), enabling
// the model to self-correct:
//   SyntaxError       → fix line N
//   ModuleNotAllowed  → use a different approach (allowed list shown)
//   Timeout           → reduce computation or split into steps
//   MemoryLimitExceeded → reduce data size
// ---------------------------------------------------------------------------

const RunCodeInputSchema = z.object({
  language: z.literal("javascript").describe("Only JavaScript is supported in the sandbox"),
  code: z.string().min(1).describe("JavaScript source to execute"),
  timeoutMs: z.number().int().positive().max(30_000).default(5_000).describe("Timeout in ms"),
  memoryMb: z.number().int().positive().max(256).default(64).describe("Max heap in MB"),
});

type RunCodeInput = z.infer<typeof RunCodeInputSchema>;

interface RunCodeOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  error?: {
    code: string;
    message: string;
    /** Only present for MODULE_NOT_ALLOWED */
    allowedModules?: readonly string[];
    /** Only present for SYNTAX_ERROR */
    line?: number;
  };
}

export interface RunCodeDeps {
  sandbox: SandboxPort;
}

export function createRunCodeTool(
  definition: ToolDefinition,
  deps: RunCodeDeps = { sandbox: new NoopSandbox() },
): Tool<RunCodeInput, RunCodeOutput> {
  return {
    definition,
    inputSchema: RunCodeInputSchema,

    async execute(input, signal) {
      const result = await deps.sandbox.run(input.code, {
        timeoutMs: input.timeoutMs,
        memoryMb: input.memoryMb,
        allowedModules: [],
        network: false,
        ...(signal !== undefined && { signal }),
      });

      if (result.ok) {
        return {
          ok: true,
          stdout: result.value.stdout,
          stderr: result.value.stderr,
          exitCode: result.value.exitCode,
          durationMs: result.value.durationMs,
        };
      }

      // Map SandboxError variants to a flat output the model can reason about
      const e = result.error;
      const base = {
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: 1,
        durationMs: 0,
      };

      switch (e.code) {
        case "TIMEOUT":
          return {
            ...base,
            error: { code: e.code, message: `Execution timed out after ${e.timeoutMs}ms` },
          };
        case "MEMORY_LIMIT_EXCEEDED":
          return {
            ...base,
            error: { code: e.code, message: `Memory limit of ${e.memoryMb}MB exceeded` },
          };
        case "MODULE_NOT_ALLOWED":
          return {
            ...base,
            error: {
              code: e.code,
              message: `Module '${e.module}' is not allowed in the sandbox`,
              allowedModules: e.allowedModules,
            },
          };
        case "SYNTAX_ERROR":
          return {
            ...base,
            error: { code: e.code, message: e.message, line: e.line },
          };
        case "CIRCUIT_OPEN":
          return {
            ...base,
            error: {
              code: e.code,
              message: `Sandbox circuit breaker is open after ${e.failureCount} failures. Retry after ${e.cooldownMs}ms.`,
            },
          };
        case "POOL_EXHAUSTED":
          return {
            ...base,
            error: {
              code: e.code,
              message: `Sandbox pool exhausted (${e.queueLength} queued). Try again later.`,
            },
          };
        default:
          return {
            ...base,
            error: { code: e.code, message: e.message },
          };
      }
    },
  };
}
