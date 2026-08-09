import { z } from "zod";

// ---------------------------------------------------------------------------
// HandoffPayload — used in T10 routing between specialist agents
// ---------------------------------------------------------------------------

export const HandoffPayloadSchema = z.object({
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  /** Domain-specific payload for the target agent (task description, partial results, etc.). */
  context: z.unknown(),
  reason: z.string().min(1),
  /** How the routing decision was reached. */
  matchedBy: z.enum(["rule", "llm", "escalation"]),
  /** Routing confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Sequential hop index (0 = first handoff after initial routing). */
  hop: z.number().int().nonnegative(),
  /**
   * Token-bounded subset of the conversation history to pass to the target agent.
   * Must always be smaller than the full history — passing the full history is
   * context copy, not a handoff.
   */
  contextSlice: z.unknown(),
});

export type HandoffPayload = z.infer<typeof HandoffPayloadSchema>;

// ---------------------------------------------------------------------------
// ApprovalRequest — used in T12 human-in-the-loop
// ---------------------------------------------------------------------------

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "timed_out"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  /** The callId from the tool.called event — used to match the in-flight call on resume. */
  callId: z.string().min(1),
  resumeToken: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
  thresholdDescription: z.string().optional(),
  expiresAt: z.string().datetime(),
  status: ApprovalStatusSchema.default("pending"),
});

export const ApprovalResponseSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string().min(1),
  decidedAt: z.string().datetime(),
  comment: z.string().optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;
