import type { ModelContext, ModelError, ModelPort, ModelResponse } from "@harness/core";
import { err, ok } from "@harness/core";
import type { Result } from "@harness/core";

/**
 * FakeModelPort — a scripted implementation of ModelPort for testing.
 *
 * Unlike a mock (which only verifies call counts), FakeModelPort is a full
 * working implementation that returns pre-configured responses in order.
 * This is essential for agent loop tests: the runtime must receive realistic
 * responses to make real decisions, not just detect that generate() was called.
 *
 * Usage:
 *   const model = new FakeModelPort([
 *     // Turn 1: request a tool call
 *     FakeModelPort.toolCallResponse([{ id: "c1", name: "myTool", args: { x: 1 } }]),
 *     // Turn 2: provide the final answer
 *     FakeModelPort.textResponse("The answer is 42."),
 *   ]);
 */
export class FakeModelPort implements ModelPort {
  private readonly responses: Array<Result<ModelResponse, ModelError>>;
  private index = 0;
  private readonly capturedContexts: ModelContext[] = [];

  constructor(responses: Array<Result<ModelResponse, ModelError>>) {
    this.responses = responses;
  }

  async generate(context: ModelContext): Promise<Result<ModelResponse, ModelError>> {
    this.capturedContexts.push(context);

    const response = this.responses[this.index];
    if (response === undefined) {
      return err({
        code: "unknown",
        message: `FakeModelPort: no more scripted responses (called ${this.index + 1} times, only ${this.responses.length} configured)`,
        retryable: false,
      });
    }

    this.index += 1;
    return response;
  }

  /** Number of times generate() has been called. */
  get callCount(): number {
    return this.index;
  }

  /** All ModelContexts passed to generate(), in order. */
  get capturedCalls(): readonly ModelContext[] {
    return this.capturedContexts;
  }

  /** Reset the call counter and captured contexts (does not reset the responses). */
  reset(): void {
    this.index = 0;
    this.capturedContexts.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Factory helpers for common response shapes
  // ---------------------------------------------------------------------------

  /** A response that requests one or more tool calls. */
  static toolCallResponse(
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    tokens = { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  ): Result<ModelResponse, ModelError> {
    return ok({
      content: null,
      toolCalls,
      usage: tokens,
      finishReason: "tool_calls",
    });
  }

  /** A terminal text response (no tool calls). */
  static textResponse(
    content: string,
    tokens = { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  ): Result<ModelResponse, ModelError> {
    return ok({
      content,
      toolCalls: [],
      usage: tokens,
      finishReason: "stop",
    });
  }

  /** A model error response (rate limit, timeout, etc.). */
  static errorResponse(
    code: ModelError["code"] = "unknown",
    message = "Simulated model error",
    retryable = false,
  ): Result<ModelResponse, ModelError> {
    return err({ code, message, retryable });
  }

  /** Create a FakeModelPort that loops forever with the same tool call (for budget tests). */
  static infiniteLoop(
    toolName: string,
    args: Record<string, unknown> = {},
    maxTurns = 100,
  ): FakeModelPort {
    const responses: Array<Result<ModelResponse, ModelError>> = Array.from(
      { length: maxTurns },
      (_, i) => FakeModelPort.toolCallResponse([{ id: `call-${i + 1}`, name: toolName, args }]),
    );
    return new FakeModelPort(responses);
  }
}
