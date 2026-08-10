import { metrics } from "@opentelemetry/api";
import type { Histogram, ObservableGauge, UpDownCounter } from "@opentelemetry/api";

const METER_NAME = "@harness/observability";
const METER_VERSION = "0.0.0";

/**
 * HarnessMetrics — pre-created OTel metric instruments.
 *
 * All instruments are created lazily from the global MeterProvider.
 * Call createHarnessMetrics() once from the composition root after
 * initOtelSdk() so the instruments bind to the configured exporter.
 *
 * Instrument naming follows the OpenTelemetry GenAI semantic conventions
 * where applicable, with harness.* prefix for project-specific metrics.
 */
export interface HarnessMetrics {
  /** Wall-clock duration of a complete workflow run in milliseconds. */
  workflowDurationMs: Histogram;
  /** Total tokens consumed by a workflow (prompt + completion). */
  workflowTokensTotal: Histogram;
  /** Estimated USD cost of a workflow. */
  workflowCostUsd: Histogram;
  /** Steps completed in a workflow. */
  workflowStepsTotal: Histogram;
  /** Wall-clock duration of a single tool call in milliseconds. */
  toolDurationMs: Histogram;
  /** Total tool call errors by tool name and error code. */
  toolErrorsTotal: UpDownCounter;
  /** Number of LLM calls made. */
  llmCallsTotal: UpDownCounter;
  /** Tokens used in a single LLM call (input). */
  llmInputTokens: Histogram;
  /** Tokens used in a single LLM call (output). */
  llmOutputTokens: Histogram;
  /** Estimated cost of a single LLM call in USD. */
  llmCostUsd: Histogram;
  /**
   * Number of jobs currently waiting in the queue (unlocked + run_after <= NOW).
   * Observable gauge — caller provides a callback that reads the current value.
   * Low-cardinality labels: plan, region (never tenant_id).
   */
  queueDepth: ObservableGauge;
  /** Number of workflows currently executing (holding a step lease). */
  activeLeases: ObservableGauge;
}

/**
 * createHarnessMetrics — create all instrumentation instruments.
 *
 * Instruments are singletons in the MeterProvider; calling this multiple
 * times with the same meter name is safe (returns the same instruments).
 */
export function createHarnessMetrics(): HarnessMetrics {
  const meter = metrics.getMeter(METER_NAME, METER_VERSION);

  return {
    workflowDurationMs: meter.createHistogram("harness.workflow.duration_ms", {
      description: "Wall-clock duration of a complete workflow run in milliseconds.",
      unit: "ms",
    }),
    workflowTokensTotal: meter.createHistogram("harness.workflow.tokens_total", {
      description: "Total tokens (prompt + completion) consumed by a workflow.",
      unit: "{token}",
    }),
    workflowCostUsd: meter.createHistogram("harness.workflow.cost_usd", {
      description: "Estimated USD cost of a workflow.",
      unit: "usd",
    }),
    workflowStepsTotal: meter.createHistogram("harness.workflow.steps_total", {
      description: "Number of tool-call steps completed in a workflow.",
      unit: "{step}",
    }),
    toolDurationMs: meter.createHistogram("harness.tool.duration_ms", {
      description: "Wall-clock duration of a single tool call in milliseconds.",
      unit: "ms",
    }),
    toolErrorsTotal: meter.createUpDownCounter("harness.tool.errors_total", {
      description: "Cumulative count of tool call errors by tool name and error code.",
      unit: "{error}",
    }),
    llmCallsTotal: meter.createUpDownCounter("harness.llm.calls_total", {
      description: "Number of LLM generate() calls made.",
      unit: "{call}",
    }),
    llmInputTokens: meter.createHistogram("harness.llm.input_tokens", {
      description: "Prompt tokens in a single LLM call.",
      unit: "{token}",
    }),
    llmOutputTokens: meter.createHistogram("harness.llm.output_tokens", {
      description: "Completion tokens in a single LLM call.",
      unit: "{token}",
    }),
    llmCostUsd: meter.createHistogram("harness.llm.cost_usd", {
      description: "Estimated cost of a single LLM call in USD.",
      unit: "usd",
    }),
    queueDepth: meter.createObservableGauge("harness.queue.depth", {
      description: "Number of jobs currently waiting in the queue (eligible for dequeue).",
      unit: "{job}",
    }),
    activeLeases: meter.createObservableGauge("harness.queue.active_leases", {
      description: "Number of workflows currently executing (holding a step lease).",
      unit: "{workflow}",
    }),
  };
}
