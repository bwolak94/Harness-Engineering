import type { ModelContext, ModelError, ModelPort, ModelResponse } from "@harness/core";
import type { Result } from "@harness/core";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import { estimateCostUsd } from "./cost-estimator.js";
import type { HarnessMetrics } from "./metrics.js";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_HARNESS_LLM_COST_USD,
  ATTR_HARNESS_WORKFLOW_ID,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
} from "./semconv.js";

/**
 * TracingModelAdapter — wraps a ModelPort to add OTel tracing for every
 * LLM generate() call.
 *
 * Span name: "gen_ai.chat" per GenAI semconv.
 * Span kind: CLIENT (outgoing call to an LLM provider).
 * Span hierarchy: child of the active context (tool_call span from withTracing,
 *   or the workflow span from TracingRuntimeAdapter if called outside a step).
 *
 * Token usage and estimated cost are recorded as span attributes AND as OTel
 * metric recordings (if a HarnessMetrics instance is provided).
 *
 * Usage:
 *   const model = new TracingModelAdapter(realModelPort, tracer, metrics);
 */
export class TracingModelAdapter implements ModelPort {
  constructor(
    private readonly inner: ModelPort,
    private readonly tracer: Tracer,
    private readonly harnessMetrics?: HarnessMetrics,
  ) {}

  async generate(ctx: ModelContext): Promise<Result<ModelResponse, ModelError>> {
    const span = this.tracer.startSpan(
      "gen_ai.chat",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [ATTR_GEN_AI_SYSTEM]: "harness",
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
          [ATTR_HARNESS_WORKFLOW_ID]: ctx.workflowId,
        },
      },
      context.active(),
    );

    const spanCtx = trace.setSpan(context.active(), span);

    const result = await context.with(spanCtx, () => this.inner.generate(ctx));

    if (result.ok) {
      const { usage, finishReason } = result.value;
      const model = ctx.taskId; // taskId used as a proxy; replaced with response model if available
      const costUsd = estimateCostUsd(model, usage.promptTokens, usage.completionTokens);

      span.setAttributes({
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.promptTokens,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.completionTokens,
        [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [finishReason],
        [ATTR_HARNESS_LLM_COST_USD]: costUsd,
      });
      span.setStatus({ code: SpanStatusCode.OK });

      if (this.harnessMetrics) {
        const labels = { "harness.workflow_id": ctx.workflowId };
        this.harnessMetrics.llmCallsTotal.add(1, labels);
        this.harnessMetrics.llmInputTokens.record(usage.promptTokens, labels);
        this.harnessMetrics.llmOutputTokens.record(usage.completionTokens, labels);
        this.harnessMetrics.llmCostUsd.record(costUsd, labels);
      }
    } else {
      span.setAttributes({
        [ATTR_GEN_AI_RESPONSE_MODEL]: "unknown",
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: result.error.message,
      });
      span.setAttribute("gen_ai.error.code", result.error.code);
    }

    span.end();
    return result;
  }
}
