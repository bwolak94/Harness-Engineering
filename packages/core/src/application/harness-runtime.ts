import type {
  StateCheckpointedEvent,
  StepPlannedEvent,
  TaskPacket,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
} from "@harness/contracts";
import { reduce } from "../domain/reducer.js";
import { initialWorkflowState } from "../domain/workflow-state.js";
import type { WorkflowState } from "../domain/workflow-state.js";
import type { ClockPort } from "../ports/clock.port.js";
import type { EventLogPort } from "../ports/event-log.port.js";
import type { IdPort } from "../ports/id.port.js";
import type { ModelContext, ModelMessage, ModelPort } from "../ports/model.port.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import type { ToolCallError, ToolRegistryPort } from "../ports/tool-registry.port.js";
import { BudgetEnforcer } from "./budget-enforcer.js";
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
