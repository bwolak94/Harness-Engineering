import type { ToolDefinition } from "@harness/contracts";
import { getToolDefinition } from "@harness/contracts/tools";
import { Supervisor } from "../application/supervisor.js";
import {
  composeDecorators,
  withPolicy,
  withResultTruncation,
  withTelemetry,
  withTimeout,
} from "../application/tool-decorators.js";
import { isDangerous } from "../application/tool-policy.js";
import { asExecutor } from "../application/tool.js";
import { tokenBudgetToChars } from "../application/truncation.js";
import { NoopSandbox } from "../ports/sandbox.port.js";
import type { ToolExecutor } from "../ports/tool-registry.port.js";
import { createAnalyzeInvestmentTool } from "./n1-analyze-investment.js";
import { createOptimizeRouteTool } from "./n2-optimize-route.js";
import { createCalculateLandedCostTool } from "./n3-calculate-landed-cost.js";
import { createScreenCandidatesTool } from "./n6-screen-candidates.js";
import { createSimulatePVPaybackTool } from "./n8-simulate-pv-payback.js";
import { createCalculateNetSalaryTool } from "./n9-calculate-net-salary.js";
import { createProposeRepricingTool } from "./n10-propose-repricing.js";
import { createRunCodeTool } from "./run-code.js";

// Re-export individual tool factories so callers can build custom variants.
export { createAnalyzeInvestmentTool } from "./n1-analyze-investment.js";
export { createOptimizeRouteTool } from "./n2-optimize-route.js";
export { createCalculateLandedCostTool } from "./n3-calculate-landed-cost.js";
export { createScreenCandidatesTool } from "./n6-screen-candidates.js";
export type { ScreenCandidatesDeps } from "./n6-screen-candidates.js";
export { createSimulatePVPaybackTool } from "./n8-simulate-pv-payback.js";
export { createCalculateNetSalaryTool } from "./n9-calculate-net-salary.js";
export { createProposeRepricingTool } from "./n10-propose-repricing.js";
export { createApplyRepricingTool } from "./n11-apply-repricing.js";
export type { ApplyRepricingDeps } from "./n11-apply-repricing.js";
export { createRunCodeTool } from "./run-code.js";
export type { RunCodeDeps } from "./run-code.js";

// ---------------------------------------------------------------------------
// Startup-time definition lookup
// ---------------------------------------------------------------------------

/**
 * Retrieve a tool definition from the contracts registry.
 * Throws synchronously at startup (not at tool invocation time) so that a
 * missing entry in TOOL_REGISTRY is caught when the composition root boots,
 * not when the model first tries to call the tool.
 */
function requireDefinition(name: string): ToolDefinition {
  const def = getToolDefinition(name);
  if (!def) {
    throw new Error(
      `Tool '${name}' is not registered in TOOL_REGISTRY (packages/contracts/src/tools/index.ts). Add it there before registering the executor.`,
    );
  }
  return def;
}

// ---------------------------------------------------------------------------
// Standard decorator stack
//
// Order (outermost → innermost):
//   withPolicy(isDangerous) → withTimeout → withResultTruncation → withTelemetry
//
// withPolicy is outermost: no work is done for blocked tools.
// withTelemetry is innermost: measures only real execution time, not policy/timeout overhead.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TOKEN_BUDGET = 50_000; // ~200 KB
const DEFAULT_MAX_CHARS = tokenBudgetToChars(DEFAULT_TOKEN_BUDGET);

const standardDecorators = composeDecorators(
  withPolicy(isDangerous()),
  withTimeout(DEFAULT_TIMEOUT_MS),
  withResultTruncation(DEFAULT_MAX_CHARS),
  withTelemetry(),
);

function decorate(executor: ToolExecutor): ToolExecutor {
  return standardDecorators(executor);
}

// ---------------------------------------------------------------------------
// createDefaultToolExecutors — call once from the composition root
// ---------------------------------------------------------------------------

/**
 * Build all tool executors with the standard decorator stack applied.
 *
 * Register each returned executor with a ToolRegistryPort:
 *
 *   for (const executor of createDefaultToolExecutors()) {
 *     registry.register(executor);
 *   }
 *
 * Not included here (require I/O deps, compose at composition root):
 *   - N11 applyRepricing — needs OutboxPort + IdempotencyStorePort
 *   - runCode with real sandbox — needs SandboxPort adapter
 *
 * Adding a new tool requires:
 *   1. Implement the Tool<I,O> factory.
 *   2. Add a `requireDefinition(name)` call here.
 *   3. Wrap with `decorate(asExecutor(...))` and push to the array.
 *   — zero changes to HarnessRuntime.
 */
export function createDefaultToolExecutors(): ToolExecutor[] {
  // Default Supervisor for N6 — concurrency limit of 10 parallel candidate evaluations.
  const supervisor = new Supervisor(10);

  return [
    decorate(asExecutor(createAnalyzeInvestmentTool(requireDefinition("analyzeInvestment")))),
    decorate(asExecutor(createOptimizeRouteTool(requireDefinition("optimizeRoute")))),
    decorate(asExecutor(createCalculateLandedCostTool(requireDefinition("calculateLandedCost")))),
    decorate(
      asExecutor(createScreenCandidatesTool(requireDefinition("screenCandidates"), { supervisor })),
    ),
    decorate(asExecutor(createSimulatePVPaybackTool(requireDefinition("simulatePVPayback")))),
    decorate(asExecutor(createCalculateNetSalaryTool(requireDefinition("calculateNetSalary")))),
    decorate(asExecutor(createProposeRepricingTool(requireDefinition("proposeRepricing")))),
    // runCode uses NoopSandbox by default — returns a helpful "not configured" error.
    // Override at composition root with a real SandboxPort adapter for actual execution.
    decorate(
      asExecutor(createRunCodeTool(requireDefinition("runCode"), { sandbox: new NoopSandbox() })),
    ),
  ];
}
