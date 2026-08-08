import type { HarnessEvent, TaskPacket, ToolCalledEvent } from "@harness/contracts";
import type { ModelMessage } from "../ports/model.port.js";

/**
 * An in-flight tool call: tool.called was emitted but no tool.succeeded/failed yet.
 * This happens when the process crashes between execute() and append(tool.succeeded).
 */
export interface InFlightCall {
  /** seq of the tool.called event — used as the idempotency key component. */
  seq: number;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  stepId: string;
}

export interface ReplayResult {
  task: TaskPacket;
  messages: ModelMessage[];
  inFlightCalls: readonly InFlightCall[];
}

/**
 * Reconstruct the conversation messages and detect in-flight calls from the
 * persisted event log.
 *
 * The reconstruction algorithm:
 *   1. system + user message from workflow.started
 *   2. Group tool calls into "turns" — each turn ends with state.checkpointed
 *   3. Each completed turn → assistant message (toolCalls) + tool result messages
 *   4. Any tool.called events after the last checkpoint without a matching
 *      tool.succeeded/failed are "in-flight" — they need to be re-executed on resume
 *
 * Note: assistant text content is not stored in events; replayed messages use
 * empty string for content. This is acceptable because the model doesn't need
 * to see its own previous text to continue using tool results.
 *
 * @throws {Error} if no workflow.started event is found
 */
export function reconstructConversation(events: readonly HarnessEvent[]): ReplayResult {
  const startedEvt = events.find((e) => e.type === "workflow.started");
  if (!startedEvt || startedEvt.type !== "workflow.started") {
    throw new Error("Cannot reconstruct conversation: no workflow.started event found");
  }
  const task = startedEvt.payload.task;

  // Build lookup maps for fast resolution
  const succeededByCallId = new Map<string, unknown>();
  const failedByCallId = new Map<string, { code: string; message: string; retryable: boolean }>();

  for (const evt of events) {
    if (evt.type === "tool.succeeded") {
      succeededByCallId.set(evt.payload.callId, evt.payload.result);
    } else if (evt.type === "tool.failed") {
      failedByCallId.set(evt.payload.callId, {
        code: evt.payload.code,
        message: evt.payload.message,
        retryable: evt.payload.retryable,
      });
    }
  }

  const SYSTEM_PROMPT =
    "You are a helpful assistant that uses tools to complete tasks. " +
    "Think step by step. When you have enough information, provide a final answer " +
    "as plain text without calling any more tools.";

  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task.goal },
  ];

  // Accumulate tool.called events for the current turn.
  // A turn is the set of tool calls between two consecutive state.checkpointed events.
  let currentTurnCalls: ToolCalledEvent[] = [];

  for (const evt of events) {
    if (evt.type === "tool.called") {
      currentTurnCalls.push(evt);
    } else if (evt.type === "state.checkpointed") {
      // End of a completed turn — push assistant + tool result messages
      if (currentTurnCalls.length > 0) {
        pushTurnMessages(messages, currentTurnCalls, succeededByCallId, failedByCallId);
        currentTurnCalls = [];
      }
    }
  }

  // Any remaining calls in currentTurnCalls belong to an in-flight (uncompleted) turn.
  // Split into: resolved calls (result known) and true in-flight calls (no result yet).
  const resolvedCalls = currentTurnCalls.filter(
    (tc) => succeededByCallId.has(tc.payload.callId) || failedByCallId.has(tc.payload.callId),
  );
  const inFlightCalls: InFlightCall[] = currentTurnCalls
    .filter(
      (tc) => !succeededByCallId.has(tc.payload.callId) && !failedByCallId.has(tc.payload.callId),
    )
    .map((tc) => ({
      seq: tc.seq,
      callId: tc.payload.callId,
      toolName: tc.payload.toolName,
      args: tc.payload.args as Record<string, unknown>,
      stepId: tc.payload.stepId,
    }));

  // If there's an in-flight turn, push the assistant message and any already-resolved
  // tool results from that same turn so the conversation is in a valid state.
  if (currentTurnCalls.length > 0) {
    // Assistant message for this partial turn
    messages.push({
      role: "assistant",
      content: null,
      toolCalls: currentTurnCalls.map((tc) => ({
        id: tc.payload.callId,
        name: tc.payload.toolName,
        args: tc.payload.args as Record<string, unknown>,
      })),
    });
    // Resolved results from this turn (in-flight ones will be filled in during resume)
    for (const tc of resolvedCalls) {
      messages.push(buildToolResultMessage(tc, succeededByCallId, failedByCallId));
    }
  }

  return { task, messages, inFlightCalls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pushTurnMessages(
  messages: ModelMessage[],
  turnCalls: ToolCalledEvent[],
  succeededByCallId: Map<string, unknown>,
  failedByCallId: Map<string, { code: string; message: string; retryable: boolean }>,
): void {
  messages.push({
    role: "assistant",
    content: null,
    toolCalls: turnCalls.map((tc) => ({
      id: tc.payload.callId,
      name: tc.payload.toolName,
      args: tc.payload.args as Record<string, unknown>,
    })),
  });

  for (const tc of turnCalls) {
    messages.push(buildToolResultMessage(tc, succeededByCallId, failedByCallId));
  }
}

function buildToolResultMessage(
  tc: ToolCalledEvent,
  succeededByCallId: Map<string, unknown>,
  failedByCallId: Map<string, { code: string; message: string; retryable: boolean }>,
): ModelMessage {
  const result = succeededByCallId.get(tc.payload.callId);
  const error = failedByCallId.get(tc.payload.callId);
  const content =
    error !== undefined
      ? JSON.stringify({ ok: false, ...error })
      : JSON.stringify({ ok: true, result });

  return {
    role: "tool",
    content,
    toolCallId: tc.payload.callId,
    name: tc.payload.toolName,
  };
}
