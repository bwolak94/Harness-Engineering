import { z } from "zod";

// ---------------------------------------------------------------------------
// WorkflowStatus
// ---------------------------------------------------------------------------

export const WorkflowStatusSchema = z.enum([
  "pending",
  "running",
  "suspended",
  "completed",
  // completed_partial: supervisor synthesis finished but at least one subagent failed (T11)
  "completed_partial",
  "failed",
  "halted",
]);

export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const BudgetSchema = z.object({
  maxTokens: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  maxWallClockMs: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
});

export type Budget = z.infer<typeof BudgetSchema>;

export const BudgetExceededReasonSchema = z.enum(["tokens", "steps", "wallClock", "costUsd"]);
export type BudgetExceededReason = z.infer<typeof BudgetExceededReasonSchema>;

export const BudgetExceededSchema = z.object({
  reason: BudgetExceededReasonSchema,
  limit: z.number(),
  actual: z.number(),
});
export type BudgetExceeded = z.infer<typeof BudgetExceededSchema>;

// ---------------------------------------------------------------------------
// TaskPacket — domain-neutral unit of work
// ---------------------------------------------------------------------------

export const TaskPacketSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.record(z.string(), z.unknown()).optional(),
  budget: BudgetSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Set when this task is a subagent spawned by a Supervisor (T11). */
  parentWorkflowId: z.string().optional(),
});

export type TaskPacket = z.infer<typeof TaskPacketSchema>;

// ---------------------------------------------------------------------------
// HarnessEvent — discriminated union (10 variants)
// ---------------------------------------------------------------------------

const BaseEventSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
});

export const WorkflowStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("workflow.started"),
  payload: z.object({
    task: TaskPacketSchema,
  }),
});

export const StepPlannedEventSchema = BaseEventSchema.extend({
  type: z.literal("step.planned"),
  payload: z.object({
    stepId: z.string().min(1),
    kind: z.enum(["tool_call", "llm_turn", "handoff"]),
    input: z.unknown(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const ToolCalledEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.called"),
  payload: z.object({
    stepId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown(),
    callId: z.string().min(1),
  }),
});

export const ToolSucceededEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.succeeded"),
  payload: z.object({
    stepId: z.string().min(1),
    callId: z.string().min(1),
    result: z.unknown(),
    durationMs: z.number().nonnegative(),
  }),
});

export const ToolFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.failed"),
  payload: z.object({
    stepId: z.string().min(1),
    callId: z.string().min(1),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  }),
});

export const StateCheckpointedEventSchema = BaseEventSchema.extend({
  type: z.literal("state.checkpointed"),
  payload: z.object({
    checkpointId: z.string().min(1),
    tokensUsed: z.number().int().nonnegative(),
    stepsCompleted: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});

export const WorkflowSuspendedEventSchema = BaseEventSchema.extend({
  type: z.literal("workflow.suspended"),
  payload: z.object({
    reason: z.string().min(1),
    resumeToken: z.string().min(1),
  }),
});

export const WorkflowResumedEventSchema = BaseEventSchema.extend({
  type: z.literal("workflow.resumed"),
  payload: z.object({
    resumeToken: z.string().min(1),
    input: z.unknown().optional(),
  }),
});

export const WorkflowCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal("workflow.completed"),
  payload: z.object({
    result: z.unknown(),
    tokensUsed: z.number().int().nonnegative(),
    stepsCompleted: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
});

export const WorkflowFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("workflow.failed"),
  payload: z.object({
    code: z.string().min(1),
    message: z.string(),
    budgetExceeded: BudgetExceededSchema.optional(),
  }),
});

// ---------------------------------------------------------------------------
// context.hydrated — emitted before every model call (T09)
// ---------------------------------------------------------------------------

export const ContextHydratedEventSchema = BaseEventSchema.extend({
  type: z.literal("context.hydrated"),
  payload: z.object({
    tokensBySection: z.object({
      system: z.number().int().nonnegative(),
      facts: z.number().int().nonnegative(),
      summaries: z.number().int().nonnegative(),
      recentTurns: z.number().int().nonnegative(),
    }),
    totalTokens: z.number().int().nonnegative(),
    /** Hash of the stable prefix (system prompt + tool schemas). Identical hash = cache hit. */
    prefixHash: z.string(),
    /** Number of history messages evicted to fit within the recentTurns budget. */
    evictedCount: z.number().int().nonnegative(),
  }),
});

// ---------------------------------------------------------------------------
// context.summarized — emitted when the Summarizer compresses evicted history (T09)
// ---------------------------------------------------------------------------

export const ContextSummarizedEventSchema = BaseEventSchema.extend({
  type: z.literal("context.summarized"),
  payload: z.object({
    summaryId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    summary: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// agent.handoff — emitted when the router transfers control to another agent (T10)
// ---------------------------------------------------------------------------

export const AgentHandoffEventSchema = BaseEventSchema.extend({
  type: z.literal("agent.handoff"),
  payload: z.object({
    fromAgent: z.string().min(1),
    toAgent: z.string().min(1),
    reason: z.string().min(1),
    /** How the routing decision was made. */
    matchedBy: z.enum(["rule", "llm", "escalation"]),
    /** Routing confidence in [0, 1]. */
    confidence: z.number().min(0).max(1),
    /** Sequential hop index (0 = first handoff). */
    hop: z.number().int().nonnegative(),
    /** Token-bounded subset of the conversation passed to the target agent. */
    contextSlice: z.unknown(),
  }),
});

// ---------------------------------------------------------------------------
// subagent.started / subagent.completed / subagent.failed — fan-out lifecycle (T11)
// ---------------------------------------------------------------------------

export const SubagentStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("subagent.started"),
  payload: z.object({
    taskId: z.string().min(1),
    parentWorkflowId: z.string().min(1),
  }),
});

export const SubagentCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal("subagent.completed"),
  payload: z.object({
    taskId: z.string().min(1),
    parentWorkflowId: z.string().min(1),
    durationMs: z.number().nonnegative(),
  }),
});

export const SubagentFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("subagent.failed"),
  payload: z.object({
    taskId: z.string().min(1),
    parentWorkflowId: z.string().min(1),
    reason: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// supervisor.synthesized — fan-out complete, results collected (T11)
// ---------------------------------------------------------------------------

export const SupervisorSynthesizedEventSchema = BaseEventSchema.extend({
  type: z.literal("supervisor.synthesized"),
  payload: z.object({
    parentWorkflowId: z.string().min(1),
    totalTasks: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    /** True when at least one subagent failed — maps to completed_partial status. */
    partial: z.boolean(),
    summary: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// approval.requested / approval.granted / approval.rejected / approval.timed_out
// Human-in-the-loop lifecycle events (T12)
// ---------------------------------------------------------------------------

export const ApprovalRequestedEventSchema = BaseEventSchema.extend({
  type: z.literal("approval.requested"),
  payload: z.object({
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    reason: z.string().min(1),
    expiresAt: z.string().datetime(),
    stepId: z.string().min(1),
    callId: z.string().min(1),
  }),
});

export const ApprovalGrantedEventSchema = BaseEventSchema.extend({
  type: z.literal("approval.granted"),
  payload: z.object({
    requestId: z.string().min(1),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime(),
    comment: z.string().optional(),
  }),
});

export const ApprovalRejectedEventSchema = BaseEventSchema.extend({
  type: z.literal("approval.rejected"),
  payload: z.object({
    requestId: z.string().min(1),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime(),
    reason: z.string().optional(),
  }),
});

export const ApprovalTimedOutEventSchema = BaseEventSchema.extend({
  type: z.literal("approval.timed_out"),
  payload: z.object({
    requestId: z.string().min(1),
    /** The default action taken when no human responded before the deadline. */
    defaultAction: z.enum(["approve", "reject"]),
    expiresAt: z.string().datetime(),
  }),
});

// ---------------------------------------------------------------------------
// budget.threshold.exceeded — emitted when cost/token usage crosses an alert
// threshold (T13). Informational — does NOT stop the workflow on its own.
// ---------------------------------------------------------------------------

export const BudgetThresholdExceededEventSchema = BaseEventSchema.extend({
  type: z.literal("budget.threshold.exceeded"),
  payload: z.object({
    /** Which budget dimension triggered the alert. */
    dimension: z.enum(["costUsd", "tokens", "steps"]),
    /** Threshold fraction that was crossed, e.g. 0.8 for 80%. */
    thresholdPct: z.number().min(0).max(1),
    /** Current value of the dimension. */
    current: z.number().nonnegative(),
    /** Budget limit for the dimension. */
    limit: z.number().positive(),
  }),
});

export const HarnessEventSchema = z.discriminatedUnion("type", [
  WorkflowStartedEventSchema,
  StepPlannedEventSchema,
  ToolCalledEventSchema,
  ToolSucceededEventSchema,
  ToolFailedEventSchema,
  StateCheckpointedEventSchema,
  WorkflowSuspendedEventSchema,
  WorkflowResumedEventSchema,
  WorkflowCompletedEventSchema,
  WorkflowFailedEventSchema,
  ContextHydratedEventSchema,
  ContextSummarizedEventSchema,
  AgentHandoffEventSchema,
  SubagentStartedEventSchema,
  SubagentCompletedEventSchema,
  SubagentFailedEventSchema,
  SupervisorSynthesizedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalGrantedEventSchema,
  ApprovalRejectedEventSchema,
  ApprovalTimedOutEventSchema,
  BudgetThresholdExceededEventSchema,
]);

export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type WorkflowStartedEvent = z.infer<typeof WorkflowStartedEventSchema>;
export type StepPlannedEvent = z.infer<typeof StepPlannedEventSchema>;
export type ToolCalledEvent = z.infer<typeof ToolCalledEventSchema>;
export type ToolSucceededEvent = z.infer<typeof ToolSucceededEventSchema>;
export type ToolFailedEvent = z.infer<typeof ToolFailedEventSchema>;
export type StateCheckpointedEvent = z.infer<typeof StateCheckpointedEventSchema>;
export type WorkflowSuspendedEvent = z.infer<typeof WorkflowSuspendedEventSchema>;
export type WorkflowResumedEvent = z.infer<typeof WorkflowResumedEventSchema>;
export type WorkflowCompletedEvent = z.infer<typeof WorkflowCompletedEventSchema>;
export type WorkflowFailedEvent = z.infer<typeof WorkflowFailedEventSchema>;
export type ContextHydratedEvent = z.infer<typeof ContextHydratedEventSchema>;
export type ContextSummarizedEvent = z.infer<typeof ContextSummarizedEventSchema>;
export type AgentHandoffEvent = z.infer<typeof AgentHandoffEventSchema>;
export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;
export type SubagentCompletedEvent = z.infer<typeof SubagentCompletedEventSchema>;
export type SubagentFailedEvent = z.infer<typeof SubagentFailedEventSchema>;
export type SupervisorSynthesizedEvent = z.infer<typeof SupervisorSynthesizedEventSchema>;
export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;
export type ApprovalGrantedEvent = z.infer<typeof ApprovalGrantedEventSchema>;
export type ApprovalRejectedEvent = z.infer<typeof ApprovalRejectedEventSchema>;
export type ApprovalTimedOutEvent = z.infer<typeof ApprovalTimedOutEventSchema>;
export type BudgetThresholdExceededEvent = z.infer<typeof BudgetThresholdExceededEventSchema>;
