import type { ApprovalResponse, TaskPacket } from "@harness/contracts";
import type { HarnessRuntime, WorkflowState } from "@harness/core";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import type { HarnessMetrics } from "./metrics.js";
import {
  ATTR_HARNESS_WORKFLOW_COST_USD,
  ATTR_HARNESS_WORKFLOW_DURATION_MS,
  ATTR_HARNESS_WORKFLOW_ID,
  ATTR_HARNESS_WORKFLOW_STATUS,
  ATTR_HARNESS_WORKFLOW_STEPS,
  ATTR_HARNESS_WORKFLOW_TOKENS,
} from "./semconv.js";

/**
 * TracingRuntimeAdapter — wraps HarnessRuntime to provide workflow-level spans.
 *
 * Creates a root span for every run() / resume() / resumeWithDecision() call.
 * The span is set as the active OTel context so child spans from withTracing
 * (tool calls) and TracingModelAdapter (LLM calls) become its children,
 * producing the full hierarchy:
 *
 *   workflow.run
 *     tool_call analyzeInvestment
 *       gen_ai.chat
 *     tool_call calculateLandedCost
 *       gen_ai.chat
 *
 * The traceId is recorded as a span attribute on the workflow span using the
 * harness.workflow_id attribute, making it trivial to jump from a workflowId
 * in the event log to the trace in Jaeger (and vice versa).
 *
 * Key DoD constraint satisfied:
 *   git diff HarnessRuntime = 0 lines
 * This adapter wraps without modifying the runtime.
 */
export class TracingRuntimeAdapter {
  constructor(
    private readonly inner: HarnessRuntime,
    private readonly tracer: Tracer,
    private readonly harnessMetrics?: HarnessMetrics,
  ) {}

  async run(task: TaskPacket): Promise<WorkflowState> {
    return this.traceOperation("workflow.run", task.id, () => this.inner.run(task));
  }

  async resume(workflowId: string): Promise<WorkflowState> {
    return this.traceOperation("workflow.resume", workflowId, () => this.inner.resume(workflowId));
  }

  async resumeWithDecision(workflowId: string, response: ApprovalResponse): Promise<WorkflowState> {
    return this.traceOperation("workflow.resume_with_decision", workflowId, () =>
      this.inner.resumeWithDecision(workflowId, response),
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async traceOperation(
    spanName: string,
    workflowId: string,
    fn: () => Promise<WorkflowState>,
  ): Promise<WorkflowState> {
    const startMs = Date.now();

    const span = this.tracer.startSpan(spanName, {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_HARNESS_WORKFLOW_ID]: workflowId,
      },
    });

    const spanCtx = trace.setSpan(context.active(), span);

    let state: WorkflowState;
    try {
      state = await context.with(spanCtx, fn);
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.end();
      throw err;
    }

    const durationMs = Date.now() - startMs;

    span.setAttributes({
      [ATTR_HARNESS_WORKFLOW_STATUS]: state.status,
      [ATTR_HARNESS_WORKFLOW_DURATION_MS]: durationMs,
      [ATTR_HARNESS_WORKFLOW_TOKENS]: state.budget.tokensUsed,
      [ATTR_HARNESS_WORKFLOW_COST_USD]: state.budget.costUsd,
      [ATTR_HARNESS_WORKFLOW_STEPS]: state.budget.stepsCompleted,
    });

    const isError = state.status === "failed" || state.status === "halted";
    span.setStatus({
      code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      ...(isError && state.error ? { message: state.error } : {}),
    });

    span.end();

    // Record workflow-level metrics.
    if (this.harnessMetrics) {
      const labels = {
        "harness.workflow_status": state.status,
      };
      this.harnessMetrics.workflowDurationMs.record(durationMs, labels);
      this.harnessMetrics.workflowTokensTotal.record(state.budget.tokensUsed, labels);
      this.harnessMetrics.workflowCostUsd.record(state.budget.costUsd, labels);
      this.harnessMetrics.workflowStepsTotal.record(state.budget.stepsCompleted, labels);
    }

    return state;
  }
}
