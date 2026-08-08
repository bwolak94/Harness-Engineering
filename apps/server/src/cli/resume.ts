/**
 * harness:resume — resume a previously interrupted workflow.
 *
 * Usage: pnpm harness:resume <workflowId>
 *
 * Connects to the configured storage (state store + event log), reconstructs
 * the workflow's conversation history, re-executes any in-flight tool calls
 * using the idempotency store, and continues the agent loop to completion.
 *
 * Exit codes:
 *   0 — workflow reached a terminal state (completed, failed, or halted)
 *   1 — workflow not found or unrecoverable error
 */
import { parseEnv } from "@harness/contracts/env";
import { WorkflowNotFoundError } from "@harness/core";
import { compose } from "../composition/compose.js";

const workflowId = process.argv[2];
if (!workflowId) {
  console.error("Usage: harness:resume <workflowId>");
  process.exit(1);
}

const env = parseEnv();
const { service } = compose(env);

console.log(`[harness:resume] Resuming workflow ${workflowId}...`);

try {
  const finalState = await service.resume(workflowId);
  console.log(`[harness:resume] Workflow ${workflowId} reached status: ${finalState.status}`);
  console.log(JSON.stringify(finalState, null, 2));
  process.exit(0);
} catch (err) {
  if (err instanceof WorkflowNotFoundError) {
    console.error(`[harness:resume] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
