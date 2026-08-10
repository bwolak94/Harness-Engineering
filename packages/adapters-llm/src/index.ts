// LLM adapter — wraps Vercel AI SDK behind ModelPort.
//
// Pattern: Adapter (Anti-Corruption Layer)
// The domain never imports `ai` or `@ai-sdk/openai` directly.
// All provider-specific types are mapped here.

import { createOpenAI } from "@ai-sdk/openai";
import type {
  ModelContext,
  ModelError,
  ModelPort,
  ModelResponse,
  ModelToolCallRequest,
} from "@harness/core";
import { err, ok } from "@harness/core";
import type { Result } from "@harness/core";
import { generateText, jsonSchema, streamText } from "ai";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VercelAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VercelAiModelPort implements ModelPort {
  private readonly model;

  constructor(config: VercelAiConfig) {
    const provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
    this.model = provider(config.model);
  }

  async generate(context: ModelContext): Promise<Result<ModelResponse, ModelError>> {
    try {
      const toolSet =
        context.tools.length > 0
          ? Object.fromEntries(
              context.tools.map((t) => [
                t.name,
                {
                  description: t.description,
                  parameters: jsonSchema(t.inputSchema),
                },
              ]),
            )
          : undefined;

      const messages = context.messages.map((m) => {
        if (m.role === "tool") {
          return {
            role: "tool" as const,
            content: [
              {
                type: "tool-result" as const,
                toolCallId: m.toolCallId ?? "",
                toolName: m.name ?? "",
                result: m.content ?? "",
              },
            ],
          };
        }
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: "assistant" as const,
            content: [
              ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
              ...m.toolCalls.map((tc) => ({
                type: "tool-call" as const,
                toolCallId: tc.id,
                toolName: tc.name,
                args: tc.args,
              })),
            ],
          };
        }
        return {
          role: m.role as "system" | "user" | "assistant",
          content: m.content ?? "",
        };
      });

      if (context.onToken) {
        // Streaming path: consume fullStream so tool calls are also drained,
        // calling onToken for each text-delta chunk along the way.
        const stream = streamText({
          model: this.model,
          ...(toolSet && { tools: toolSet }),
          messages,
          maxSteps: 1,
        });

        for await (const chunk of stream.fullStream) {
          if (chunk.type === "text-delta") {
            context.onToken(chunk.textDelta);
          }
        }

        const [text, rawToolCalls, usage, finishReason] = await Promise.all([
          stream.text,
          stream.toolCalls,
          stream.usage,
          stream.finishReason,
        ]);

        const toolCalls: ModelToolCallRequest[] = rawToolCalls.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          args: tc.args as Record<string, unknown>,
        }));
        return ok({
          content: text || null,
          toolCalls,
          usage: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          },
          finishReason: mapFinishReason(finishReason),
        });
      }

      // Non-streaming path.
      const result = await generateText({
        model: this.model,
        ...(toolSet && { tools: toolSet }),
        messages,
        maxSteps: 1,
      });

      const toolCalls: ModelToolCallRequest[] = result.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        args: tc.args as Record<string, unknown>,
      }));

      return ok({
        content: result.text || null,
        toolCalls,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        },
        finishReason: mapFinishReason(result.finishReason),
      });
    } catch (e) {
      return err(classifyError(e));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string): "stop" | "tool_calls" | "length" | "error" {
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "stop";
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(e: unknown): ModelError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();

  if (lower.includes("rate limit") || lower.includes("429")) {
    return { code: "rate_limit", message: msg, retryable: true };
  }
  if (lower.includes("context") || lower.includes("token") || lower.includes("length")) {
    return { code: "context_length", message: msg, retryable: false };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { code: "timeout", message: msg, retryable: true };
  }
  if (lower.includes("500") || lower.includes("server error")) {
    return { code: "server_error", message: msg, retryable: true };
  }
  return { code: "unknown", message: msg, retryable: false };
}
