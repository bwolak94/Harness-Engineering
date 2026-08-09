import type { HarnessMiddleware, ToolCallInput } from "@harness/core";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import type { HarnessMetrics } from "./metrics.js";
import {
  ATTR_HARNESS_CALL_ID,
  ATTR_HARNESS_STEP_ID,
  ATTR_HARNESS_TOOL_DURATION_MS,
  ATTR_HARNESS_TOOL_ERROR_CODE,
  ATTR_HARNESS_TOOL_NAME,
  ATTR_HARNESS_TOOL_SUCCESS,
  ATTR_HARNESS_WORKFLOW_ID,
} from "./semconv.js";

/**
 * withTracing — HarnessMiddleware that wraps each tool-call step in an OTel span.
 *
 * Placement: inject as the FIRST item in the user middleware array passed to
 * HarnessRuntime so it wraps all other middleware and the tool executor:
 *
 *   const runtime = new HarnessRuntime({
 *     middleware: [withTracing(tracer, metrics)],
 *     ...
 *   });
 *
 * The span inherits the active OTel context — when TracingRuntimeAdapter is
 * used, the workflow span is already active, making tool spans its children.
 *
 * This middleware NEVER modifies HarnessRuntime — it is a pure decorator.
 */
export function withTracing(tracer: Tracer, harnessMetrics?: HarnessMetrics): HarnessMiddleware {
  return async (ctx, next) => {
    const input = ctx.step.input as ToolCallInput;

    const span = tracer.startSpan(
      `tool_call ${input.toolName}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_HARNESS_WORKFLOW_ID]: ctx.workflowId,
          [ATTR_HARNESS_STEP_ID]: ctx.step.stepId,
          [ATTR_HARNESS_TOOL_NAME]: input.toolName,
          [ATTR_HARNESS_CALL_ID]: input.callId,
        },
      },
      context.active(),
    );

    const spanCtx = trace.setSpan(context.active(), span);

    try {
      await context.with(spanCtx, next);

      const success = ctx.bag.error === null;
      span.setAttribute(ATTR_HARNESS_TOOL_SUCCESS, success);
      span.setAttribute(ATTR_HARNESS_TOOL_DURATION_MS, ctx.bag.durationMs);

      if (success) {
        span.setStatus({ code: SpanStatusCode.OK });
      } else {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: ctx.bag.error?.message ?? "tool call failed",
        });
        if (ctx.bag.error) {
          span.setAttribute(ATTR_HARNESS_TOOL_ERROR_CODE, ctx.bag.error.code);
        }
      }

      // Record per-tool metrics if instruments were provided.
      if (harnessMetrics) {
        harnessMetrics.toolDurationMs.record(ctx.bag.durationMs, {
          "harness.tool_name": input.toolName,
          "harness.tool_success": String(success),
        });

        if (!success && ctx.bag.error) {
          harnessMetrics.toolErrorsTotal.add(1, {
            "harness.tool_name": input.toolName,
            "harness.tool_error_code": ctx.bag.error.code,
          });
        }
      }
    } finally {
      span.end();
    }
  };
}
