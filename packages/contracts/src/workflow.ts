import { z } from "zod";

// ---------------------------------------------------------------------------
// WorkflowStatus
// ---------------------------------------------------------------------------

export const WorkflowStatusSchema = z.enum([
  "pending",
  "running",
  "suspended",
  "completed",
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
