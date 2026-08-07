/**
 * Branded (nominal) types — prevent accidental ID mixups at compile time.
 *
 * Usage:
 *   const id = "abc-123" as WorkflowId;
 *   function foo(id: WorkflowId) { ... }
 *   foo("abc-123" as StepId); // TypeScript error
 */

declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type WorkflowId = Brand<string, "WorkflowId">;
export type StepId = Brand<string, "StepId">;
export type ToolName = Brand<string, "ToolName">;
export type CallId = Brand<string, "CallId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type ResumeToken = Brand<string, "ResumeToken">;

/** Unsafely cast a string to a branded type. Use only at system entry points. */
export function asWorkflowId(s: string): WorkflowId {
  return s as WorkflowId;
}
export function asStepId(s: string): StepId {
  return s as StepId;
}
export function asToolName(s: string): ToolName {
  return s as ToolName;
}
export function asCallId(s: string): CallId {
  return s as CallId;
}
export function asCheckpointId(s: string): CheckpointId {
  return s as CheckpointId;
}
export function asResumeToken(s: string): ResumeToken {
  return s as ResumeToken;
}
