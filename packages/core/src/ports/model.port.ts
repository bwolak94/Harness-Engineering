import type { Result } from "../domain/result.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present when role === "tool" */
  toolCallId?: string;
  /** Present when role === "tool" */
  name?: string;
  /** Present when role === "assistant" and model requested tool calls */
  toolCalls?: ModelToolCallRequest[];
}

export interface ModelToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Context sent to the model
// ---------------------------------------------------------------------------

export interface ModelContext {
  messages: readonly ModelMessage[];
  /** JSON Schema tool definitions derived from the tool registry */
  tools: readonly ModelToolSchema[];
  workflowId: string;
  taskId: string;
  /** Called with each streamed text chunk. Adapter uses streamText when provided. */
  onToken?: (token: string) => void;
}

export interface ModelToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response from the model
// ---------------------------------------------------------------------------

export interface ModelResponse {
  /** Text content, null when the model only issued tool calls */
  content: string | null;
  toolCalls: readonly ModelToolCallRequest[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: "stop" | "tool_calls" | "length" | "error";
}

export interface ModelError {
  code: "rate_limit" | "context_length" | "timeout" | "server_error" | "unknown";
  message: string;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ModelPort {
  generate(context: ModelContext): Promise<Result<ModelResponse, ModelError>>;
}
