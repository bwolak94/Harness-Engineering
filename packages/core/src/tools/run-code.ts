import type { ToolDefinition } from "@harness/contracts";
import { z } from "zod";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// runCode — stub (real sandbox in T08)
// ---------------------------------------------------------------------------

const RunCodeInputSchema = z.object({
  language: z.enum(["python", "javascript", "typescript"]).describe("Target language"),
  code: z.string().min(1).describe("Source code to execute"),
  // Optional with no default to avoid exactOptionalPropertyTypes conflict (T08 can add default later)
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30_000)
    .optional()
    .describe("Timeout in ms (default: 5000)"),
});

type RunCodeInput = z.infer<typeof RunCodeInputSchema>;
type RunCodeOutput = { stdout: string; stderr: string; exitCode: number };

export function createRunCodeTool(definition: ToolDefinition): Tool<RunCodeInput, RunCodeOutput> {
  return {
    definition,
    inputSchema: RunCodeInputSchema,

    async execute(_input, _signal) {
      // Intentionally not implemented: secure sandboxing requires worker_threads
      // isolation which is added in T08. Returning a structured error here so the
      // model can self-correct ("runCode is not yet available; use a different tool").
      throw new Error(
        "runCode is not implemented in this version of the harness (planned for T08). " +
          "Use a domain-specific calculation tool instead.",
      );
    },
  };
}
