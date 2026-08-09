/**
 * Semantic conventions for GenAI and Harness-specific spans.
 *
 * GenAI attributes come from the OpenTelemetry experimental_attributes module
 * (spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/).
 * We re-export only the subset used in this package to avoid coupling callers
 * to the semconv package directly and to keep the surface stable across semconv
 * version upgrades.
 *
 * Harness-specific attributes use the "harness.*" namespace.
 */
export {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
} from "@opentelemetry/semantic-conventions/incubating";

// ---------------------------------------------------------------------------
// Harness-specific attribute keys (not in the upstream semconv)
// ---------------------------------------------------------------------------

/** Workflow identifier — correlates span with the HarnessEvent log. */
export const ATTR_HARNESS_WORKFLOW_ID = "harness.workflow_id" as const;

/** Step identifier within the workflow. */
export const ATTR_HARNESS_STEP_ID = "harness.step_id" as const;

/** Tool call identifier (matches tool.called event payload.callId). */
export const ATTR_HARNESS_CALL_ID = "harness.call_id" as const;

/** Name of the tool being called. */
export const ATTR_HARNESS_TOOL_NAME = "harness.tool_name" as const;

/** True when the tool call succeeded; false on error or suspension. */
export const ATTR_HARNESS_TOOL_SUCCESS = "harness.tool_success" as const;

/** ToolCallError code when the tool failed. */
export const ATTR_HARNESS_TOOL_ERROR_CODE = "harness.tool_error_code" as const;

/** Duration of the tool execution in milliseconds. */
export const ATTR_HARNESS_TOOL_DURATION_MS = "harness.tool_duration_ms" as const;

/** Workflow terminal status after run() / resume() completes. */
export const ATTR_HARNESS_WORKFLOW_STATUS = "harness.workflow_status" as const;

/** Total wall-clock duration of the workflow run in milliseconds. */
export const ATTR_HARNESS_WORKFLOW_DURATION_MS = "harness.workflow_duration_ms" as const;

/** Total tokens consumed by the workflow. */
export const ATTR_HARNESS_WORKFLOW_TOKENS = "harness.workflow_tokens" as const;

/** Estimated USD cost of the workflow. */
export const ATTR_HARNESS_WORKFLOW_COST_USD = "harness.workflow_cost_usd" as const;

/** Number of steps completed in the workflow. */
export const ATTR_HARNESS_WORKFLOW_STEPS = "harness.workflow_steps" as const;

/** Estimated USD cost of a single LLM call. */
export const ATTR_HARNESS_LLM_COST_USD = "harness.llm_cost_usd" as const;
