import { z } from "zod";

// ---------------------------------------------------------------------------
// ToolDefinition — metadata for a single callable tool
// ---------------------------------------------------------------------------

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  dangerous: z.boolean(),
  idempotent: z.boolean(),
  costHint: z.enum(["free", "cheap", "moderate", "expensive"]).default("free"),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// ---------------------------------------------------------------------------
// ToolCall — a single invocation request
// ---------------------------------------------------------------------------

export const ToolCallSchema = z.object({
  callId: z.string().min(1),
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

// ---------------------------------------------------------------------------
// ToolResult — structured success or failure
// ---------------------------------------------------------------------------

export const ToolResultSuccessSchema = z.object({
  ok: z.literal(true),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  result: z.unknown(),
  durationMs: z.number().nonnegative(),
});

export const ToolResultErrorSchema = z.object({
  ok: z.literal(false),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  durationMs: z.number().nonnegative(),
});

export const ToolResultSchema = z.discriminatedUnion("ok", [
  ToolResultSuccessSchema,
  ToolResultErrorSchema,
]);

export type ToolResultSuccess = z.infer<typeof ToolResultSuccessSchema>;
export type ToolResultError = z.infer<typeof ToolResultErrorSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
