import type {
  StateCheckpointedEvent,
  StepPlannedEvent,
  TaskPacket,
  ToolFailedEvent,
  ToolSucceededEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
} from "@harness/contracts";
import { reduce } from "../domain/reducer.js";
import { initialWorkflowState } from "../domain/workflow-state.js";
import type { WorkflowState } from "../domain/workflow-state.js";
import type { ClockPort } from "../ports/clock.port.js";
import type { EventLogPort } from "../ports/event-log.port.js";
import type { IdPort } from "../ports/id.port.js";
import {
  type IdempotencyStorePort,
  NoopIdempotencyStore,
  buildIdempotencyKey,
} from "../ports/idempotency-store.port.js";
import type { ModelContext, ModelMessage, ModelPort } from "../ports/model.port.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import type { ToolCallError, ToolRegistryPort } from "../ports/tool-registry.port.js";
import { BudgetEnforcer } from "./budget-enforcer.js";
import { reconstructConversation } from "./conversation-replay.js";
import { LoopDetector } from "./loop-detector.js";
import {
  type HarnessMiddleware,
  compose,
  withEventEmission,
  withLoopDetection,
  withTiming,
} from "./middleware.js";
import { type ToolCallInput, createStepBag } from "./step.js";

export interface HarnessRuntimeDeps {
  model: ModelPort;
  eventLog: EventLogPort;
  stateStore: StateStorePort;
  toolRegistry: ToolRegistryPort;
  clock: ClockPort;
  idPort: IdPort;
  /**
   * Custom middleware to apply around each tool-call step.
   * withTiming and withEventEmission are always appended by the runtime —
   * do not include them here unless you want them applied twice.
   */
  middleware: readonly HarnessMiddleware[];
  /**
   * Optional idempotency store for durable execution (T07).
   * When provided, tool results are cached by (workflowId, seq, toolName)
   * so that resume() after a crash does not re-execute completed tools.
   * Defaults to NoopIdempotencyStore (no caching — re-executes on resume).
   */
  idempotencyStore?: IdempotencyStorePort;
}

/** Thrown by resume() when the workflow does not exist in the state store. */
export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Workflow '${workflowId}' not found in state store`);
    this.name = "WorkflowNotFoundError";
  }
}

const SYSTEM_PROMPT =
  "You are a helpful assistant that uses tools to complete tasks. " +
  "Think step by step. When you have enough information, provide a final answer " +
  "as plain text without calling any more tools.";

/**
 * HarnessRuntime — the core agent execution loop.
 *
 * Loop: hydrate → plan → execute (via middleware chain) → append → checkpoint.
 *
 * The runtime knows zero I/O details — it communicates exclusively through
 * the injected ports. Swapping in-memory adapters for Postgres adapters (T06)
 * requires zero changes here. That is the point of hexagonal architecture.
 */
export class HarnessRuntime {
  private readonly deps: HarnessRuntimeDeps;

  constructor(deps: HarnessRuntimeDeps) {
    this.deps = deps;
  }

  async run(task: TaskPacket): Promise<WorkflowState> {
    const { model, eventLog, stateStore, toolRegistry, clock, idPort, middleware } = this.deps;

    // Use the task's own id as the workflowId so callers know it before the runtime starts.
    const workflowId = task.id;
    let state = initialWorkflowState(workflowId);
    let storeVersion = 0;

    // --- workflow.started ---
    const startedEvent: WorkflowStartedEvent = {
      id: idPort.newId(),
      workflowId,
      seq: 0,
      at: clock.nowIso(),
      type: "workflow.started",
      payload: { task },
    };
    await eventLog.append(startedEvent);
    state = reduce(state, startedEvent);
    await stateStore.save(workflowId, state, storeVersion++);

    const messages: ModelMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task.goal },
    ];

    const enforcer = new BudgetEnforcer(task.budget);
    const detector = new LoopDetector();

    // Build terminal middleware: execute the actual tool and write result to bag.
    const executeTool: HarnessMiddleware = async (ctx, _next) => {
      const input = ctx.step.input as ToolCallInput;
      const executor = ctx.toolRegistry.get(input.toolName);

      if (!executor) {
        const available = toolRegistry
          .list()
          .map((e) => e.definition.name)
          .join(", ");
        ctx.bag.error = {
          code: "TOOL_NOT_FOUND",
          message: `Tool '${input.toolName}' is not registered. Available tools: ${available || "none"}`,
          retryable: false,
        };
        return;
      }

      const result = await executor.execute(input.args);
      if (result.ok) {
        ctx.bag.result = result.value;
      } else {
        ctx.bag.error = result.error;
      }
    };

    // Compose: user middleware → loop detection → timing → event emission → tool execution.
    // Ordering rationale:
    //   1. User middleware outermost (can observe everything below).
    //   2. withLoopDetection before withTiming/withEventEmission — it sets
    //      bag.correctiveMessage which the runtime reads after the chain.
    //   3. withTiming wraps withEventEmission so durationMs is set before
    //      tool.succeeded is emitted.
    //   4. executeTool innermost — the actual side-effecting operation.
    const chain = compose(
      ...middleware,
      withLoopDetection(detector),
      withTiming(),
      withEventEmission(),
      executeTool,
    );

    const startMs = clock.now();
    let running = true;

    while (running) {
      // --- Budget gate (checked before calling the model) ---
      const exceeded = enforcer.check(state.budget);
      if (exceeded) {
        const failedEvent: WorkflowFailedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.failed",
          payload: {
            code: "BUDGET_EXCEEDED",
            message: `Budget exceeded: ${exceeded.reason} limit of ${exceeded.limit} reached (actual: ${exceeded.actual})`,
            budgetExceeded: exceeded,
          },
        };
        await eventLog.append(failedEvent);
        state = reduce(state, failedEvent);
        await stateStore.save(workflowId, state, storeVersion++);
        running = false;
        break;
      }

      // --- Plan: call the model ---
      const modelCtx: ModelContext = {
        messages,
        tools: toolRegistry.schemas().map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
        workflowId,
        taskId: task.id,
      };

      const modelResult = await model.generate(modelCtx);

      if (!modelResult.ok) {
        const { error } = modelResult;
        const failedEvent: WorkflowFailedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.failed",
          payload: {
            code: error.code,
            message: error.message,
          },
        };
        await eventLog.append(failedEvent);
        state = reduce(state, failedEvent);
        await stateStore.save(workflowId, state, storeVersion++);
        running = false;
        break;
      }

      const response = modelResult.value;

      // Accumulate token usage into local budget (reflected at checkpoint).
      const updatedBudget = {
        ...state.budget,
        tokensUsed: state.budget.tokensUsed + response.usage.totalTokens,
        wallClockMs: clock.now() - startMs,
      };
      state = { ...state, budget: updatedBudget };

      // --- Execute: no tool calls → workflow is done ---
      if (response.toolCalls.length === 0 || response.finishReason === "stop") {
        const completedEvent: WorkflowCompletedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.completed",
          payload: {
            result: response.content,
            tokensUsed: state.budget.tokensUsed,
            stepsCompleted: state.budget.stepsCompleted,
            totalCostUsd: state.budget.costUsd,
            durationMs: clock.now() - startMs,
          },
        };
        await eventLog.append(completedEvent);
        state = reduce(state, completedEvent);
        await stateStore.save(workflowId, state, storeVersion++);
        running = false;
        break;
      }

      // Add assistant message (with tool calls) to conversation history.
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: [...response.toolCalls],
      });

      // --- Execute each tool call through the middleware chain ---
      for (const toolCall of response.toolCalls) {
        const stepId = idPort.newId();
        const input: ToolCallInput = {
          toolName: toolCall.name,
          args: toolCall.args,
          callId: toolCall.id,
        };

        // Emit step.planned before running the chain.
        const planEvent: StepPlannedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "step.planned",
          payload: {
            stepId,
            kind: "tool_call",
            input,
          },
        };
        await eventLog.append(planEvent);
        state = reduce(state, planEvent);

        // Build step context — bag.nextSeq starts after the step.planned seq.
        const bag = createStepBag(state.seq + 1);

        const ctx = {
          step: { stepId, kind: "tool_call" as const, input },
          workflowId,
          budget: task.budget,
          state,
          eventLog,
          toolRegistry,
          clock,
          idPort,
          bag,
        };

        // Run the middleware chain (terminal: executeTool).
        await chain(ctx, async () => {});

        // If budget was exceeded inside the chain, halt immediately.
        if (bag.budgetExceeded !== null) {
          const failedEvent: WorkflowFailedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + bag.emittedEvents.length + 1,
            at: clock.nowIso(),
            type: "workflow.failed",
            payload: {
              code: "BUDGET_EXCEEDED",
              message: `Budget exceeded: ${bag.budgetExceeded.reason}`,
              budgetExceeded: bag.budgetExceeded,
            },
          };
          await eventLog.append(failedEvent);
          // Apply all events emitted by the chain then the failed event.
          for (const evt of bag.emittedEvents) {
            state = reduce(state, evt);
          }
          state = reduce(state, failedEvent);
          await stateStore.save(workflowId, state, storeVersion++);
          running = false;
          break;
        }

        // Apply events emitted by the chain to local state.
        for (const evt of bag.emittedEvents) {
          state = reduce(state, evt);
        }

        // Inject loop-detection corrective message if the detector fired.
        if (bag.correctiveMessage !== null) {
          messages.push({ role: "user", content: bag.correctiveMessage });
        }

        // Add tool result to conversation history.
        // Tool errors are returned as data to the model (Result pattern).
        const toolResultContent = buildToolResultContent(bag.error, bag.result);
        messages.push({
          role: "tool",
          content: toolResultContent,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
      }

      if (!running) break;

      // --- Checkpoint state after processing all tool calls for this turn ---
      const checkpointId = idPort.newId();
      const checkpointEvent: StateCheckpointedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "state.checkpointed",
        payload: {
          checkpointId,
          tokensUsed: state.budget.tokensUsed,
          stepsCompleted: state.budget.stepsCompleted,
          costUsd: state.budget.costUsd,
        },
      };
      await eventLog.append(checkpointEvent);
      state = reduce(state, checkpointEvent);
      await stateStore.save(workflowId, state, storeVersion++);
    }

    return state;
  }

  /**
   * resume — restore a workflow and continue exactly from where it crashed.
   *
   * Algorithm:
   *   1. Load versioned state from the state store.
   *   2. If the workflow is already in a terminal state, return it immediately.
   *   3. Replay all events to reconstruct the conversation messages.
   *   4. Detect in-flight tool calls (tool.called without tool.succeeded/failed).
   *   5. Emit workflow.resumed.
   *   6. For each in-flight call: check idempotency store first, then re-execute.
   *   7. Checkpoint if any in-flight calls were resolved.
   *   8. Continue the main run() loop.
   *
   * Pattern: Write-Ahead Log — the event log is the WAL; resume reads it to
   * determine exactly what was in-flight and recovers without data loss.
   *
   * @throws {WorkflowNotFoundError} if workflowId is not in the state store.
   */
  async resume(workflowId: string): Promise<WorkflowState> {
    const { model, eventLog, stateStore, toolRegistry, clock, idPort, middleware } = this.deps;
    const idempotencyStore: IdempotencyStorePort =
      this.deps.idempotencyStore ?? new NoopIdempotencyStore();

    // --- Load state ---
    const versioned = await stateStore.load(workflowId);
    if (!versioned) {
      throw new WorkflowNotFoundError(workflowId);
    }
    let { state } = versioned;
    let storeVersion = versioned.version;

    // --- Already terminal: nothing to resume ---
    if (state.status === "completed" || state.status === "failed" || state.status === "halted") {
      return state;
    }

    // --- Reconstruct conversation from event log ---
    const events = await eventLog.read(workflowId);
    const { task, messages, inFlightCalls } = reconstructConversation(events);

    // Fast-forward local state by replaying events that are newer than the
    // last checkpoint saved in the state store. The state store reflects the
    // last state.checkpointed event; the event log may have subsequent events
    // (e.g., step.planned, tool.called from an incomplete turn that was
    // interrupted before the next checkpoint). Replaying them ensures that
    // state.seq is the true maximum seq so new events receive correct numbers.
    const eventsAfterCheckpoint = events.filter((e) => e.seq > state.seq);
    for (const evt of eventsAfterCheckpoint) {
      state = reduce(state, evt);
    }

    // --- Emit workflow.resumed ---
    const resumedEvent: WorkflowResumedEvent = {
      id: idPort.newId(),
      workflowId,
      seq: state.seq + 1,
      at: clock.nowIso(),
      type: "workflow.resumed",
      payload: { resumeToken: idPort.newId() },
    };
    await eventLog.append(resumedEvent);
    state = reduce(state, resumedEvent);
    await stateStore.save(workflowId, state, storeVersion++);

    // --- Recover in-flight tool calls ---
    // These are calls where tool.called was emitted but the process crashed before
    // tool.succeeded/tool.failed was written. We re-execute them with idempotency.
    if (inFlightCalls.length > 0) {
      for (const call of inFlightCalls) {
        const iKey = buildIdempotencyKey(workflowId, call.seq, call.toolName);
        let result: unknown;
        let callError: ToolCallError | null = null;

        const cached = await idempotencyStore.get(iKey);
        if (cached !== undefined) {
          // Idempotency hit: result was stored after execution but before event was appended.
          result = cached;
        } else {
          // No cached result: re-execute the tool.
          const executor = toolRegistry.get(call.toolName);
          if (!executor) {
            callError = {
              code: "TOOL_NOT_FOUND",
              message: `Tool '${call.toolName}' not found during resume`,
              retryable: false,
            };
          } else {
            const execResult = await executor.execute(call.args);
            if (execResult.ok) {
              result = execResult.value;
              // Store before appending event so future crashes use the cache.
              await idempotencyStore.set(iKey, result);
            } else {
              callError = execResult.error;
            }
          }
        }

        // Emit the resolved event
        if (callError === null) {
          const succeededEvent: ToolSucceededEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "tool.succeeded",
            payload: {
              stepId: call.stepId,
              callId: call.callId,
              result,
              durationMs: 0, // duration unknown after crash recovery
            },
          };
          await eventLog.append(succeededEvent);
          state = reduce(state, succeededEvent);
          messages.push({
            role: "tool",
            content: JSON.stringify({ ok: true, result }),
            toolCallId: call.callId,
            name: call.toolName,
          });
        } else {
          const failedEvent: ToolFailedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "tool.failed",
            payload: {
              stepId: call.stepId,
              callId: call.callId,
              code: callError.code,
              message: callError.message,
              retryable: callError.retryable,
            },
          };
          await eventLog.append(failedEvent);
          state = reduce(state, failedEvent);
          messages.push({
            role: "tool",
            content: JSON.stringify({ ok: false, ...callError }),
            toolCallId: call.callId,
            name: call.toolName,
          });
        }
      }

      // Checkpoint after recovering in-flight calls
      const checkpointEvent: StateCheckpointedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "state.checkpointed",
        payload: {
          checkpointId: idPort.newId(),
          tokensUsed: state.budget.tokensUsed,
          stepsCompleted: state.budget.stepsCompleted,
          costUsd: state.budget.costUsd,
        },
      };
      await eventLog.append(checkpointEvent);
      state = reduce(state, checkpointEvent);
      await stateStore.save(workflowId, state, storeVersion++);
    }

    // --- Continue the main loop from where we left off ---
    const enforcer = new BudgetEnforcer(task.budget);
    const detector = new LoopDetector();

    const executeTool: HarnessMiddleware = async (ctx, _next) => {
      const input = ctx.step.input as ToolCallInput;
      const executor = toolRegistry.get(input.toolName);

      if (!executor) {
        const available = toolRegistry
          .list()
          .map((e) => e.definition.name)
          .join(", ");
        ctx.bag.error = {
          code: "TOOL_NOT_FOUND",
          message: `Tool '${input.toolName}' is not registered. Available tools: ${available || "none"}`,
          retryable: false,
        };
        return;
      }

      // Check idempotency store before executing
      const iKey = buildIdempotencyKey(workflowId, ctx.bag.nextSeq, input.toolName);
      const cached = await idempotencyStore.get(iKey);
      if (cached !== undefined) {
        ctx.bag.result = cached;
        return;
      }

      const execResult = await executor.execute(input.args);
      if (execResult.ok) {
        ctx.bag.result = execResult.value;
        // Store result before appending event for crash safety
        await idempotencyStore.set(iKey, execResult.value);
      } else {
        ctx.bag.error = execResult.error;
      }
    };

    const chain = compose(
      ...middleware,
      withLoopDetection(detector),
      withTiming(),
      withEventEmission(),
      executeTool,
    );

    const startMs = clock.now();
    let running = true;

    while (running) {
      const exceeded = enforcer.check(state.budget);
      if (exceeded) {
        const failedEvent: WorkflowFailedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.failed",
          payload: {
            code: "BUDGET_EXCEEDED",
            message: `Budget exceeded: ${exceeded.reason} limit of ${exceeded.limit} reached (actual: ${exceeded.actual})`,
            budgetExceeded: exceeded,
          },
        };
        await eventLog.append(failedEvent);
        state = reduce(state, failedEvent);
        await stateStore.save(workflowId, state, storeVersion++);
        running = false;
        break;
      }

      const modelCtx: ModelContext = {
        messages,
        tools: toolRegistry.schemas().map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
        workflowId,
        taskId: task.id,
      };

      const modelResult = await model.generate(modelCtx);

      if (!modelResult.ok) {
        const { error } = modelResult;
        const failedEvent: WorkflowFailedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.failed",
          payload: { code: error.code, message: error.message },
        };
        await eventLog.append(failedEvent);
        state = reduce(state, failedEvent);
        await stateStore.save(workflowId, state, storeVersion++);
        running = false;
        break;
      }

      const response = modelResult.value;

      const updatedBudget = {
        ...state.budget,
        tokensUsed: state.budget.tokensUsed + response.usage.totalTokens,
        wallClockMs: clock.now() - startMs,
      };
      state = { ...state, budget: updatedBudget };

      if (response.toolCalls.length === 0 || response.finishReason === "stop") {
        const completedEvent: WorkflowCompletedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.completed",
          payload: {
            result: response.content,
            tokensUsed: state.budget.tokensUsed,
            stepsCompleted: state.budget.stepsCompleted,
            totalCostUsd: state.budget.costUsd,
            durationMs: clock.now() - startMs,
          },
        };
        await eventLog.append(completedEvent);
        state = reduce(state, completedEvent);
        await stateStore.save(workflowId, state, storeVersion++);
        running = false;
        break;
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: [...response.toolCalls],
      });

      for (const toolCall of response.toolCalls) {
        const stepId = idPort.newId();
        const input: ToolCallInput = {
          toolName: toolCall.name,
          args: toolCall.args,
          callId: toolCall.id,
        };

        const planEvent: StepPlannedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "step.planned",
          payload: { stepId, kind: "tool_call", input },
        };
        await eventLog.append(planEvent);
        state = reduce(state, planEvent);

        const bag = createStepBag(state.seq + 1);
        const ctx = {
          step: { stepId, kind: "tool_call" as const, input },
          workflowId,
          budget: task.budget,
          state,
          eventLog,
          toolRegistry,
          clock,
          idPort,
          bag,
        };

        await chain(ctx, async () => {});

        if (bag.budgetExceeded !== null) {
          const failedEvent: WorkflowFailedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + bag.emittedEvents.length + 1,
            at: clock.nowIso(),
            type: "workflow.failed",
            payload: {
              code: "BUDGET_EXCEEDED",
              message: `Budget exceeded: ${bag.budgetExceeded.reason}`,
              budgetExceeded: bag.budgetExceeded,
            },
          };
          await eventLog.append(failedEvent);
          for (const evt of bag.emittedEvents) {
            state = reduce(state, evt);
          }
          state = reduce(state, failedEvent);
          await stateStore.save(workflowId, state, storeVersion++);
          running = false;
          break;
        }

        for (const evt of bag.emittedEvents) {
          state = reduce(state, evt);
        }

        if (bag.correctiveMessage !== null) {
          messages.push({ role: "user", content: bag.correctiveMessage });
        }

        const toolResultContent = buildToolResultContent(bag.error, bag.result);
        messages.push({
          role: "tool",
          content: toolResultContent,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
      }

      if (!running) break;

      const checkpointId = idPort.newId();
      const checkpointEvent: StateCheckpointedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "state.checkpointed",
        payload: {
          checkpointId,
          tokensUsed: state.budget.tokensUsed,
          stepsCompleted: state.budget.stepsCompleted,
          costUsd: state.budget.costUsd,
        },
      };
      await eventLog.append(checkpointEvent);
      state = reduce(state, checkpointEvent);
      await stateStore.save(workflowId, state, storeVersion++);
    }

    return state;
  }
}

function buildToolResultContent(error: ToolCallError | null, result: unknown): string {
  if (error !== null) {
    return JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      retryable: error.retryable,
    });
  }
  return JSON.stringify({ ok: true, result });
}
