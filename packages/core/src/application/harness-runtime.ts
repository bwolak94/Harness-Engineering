import type {
  ApprovalGrantedEvent,
  ApprovalRejectedEvent,
  ApprovalRequestedEvent,
  ApprovalTimedOutEvent,
  ApprovalResponse,
  ContextHydratedEvent,
  ContextSummarizedEvent,
  StateCheckpointedEvent,
  StepPlannedEvent,
  TaskPacket,
  ToolFailedEvent,
  ToolSucceededEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowSuspendedEvent,
} from "@harness/contracts";
import { reduce } from "../domain/reducer.js";
import { initialWorkflowState } from "../domain/workflow-state.js";
import type { WorkflowState } from "../domain/workflow-state.js";
import { NoopApprovalStore, type ApprovalStorePort } from "../ports/approval-store.port.js";
import type { ClockPort } from "../ports/clock.port.js";
import type { EventLogPort } from "../ports/event-log.port.js";
import type { IdPort } from "../ports/id.port.js";
import {
  type IdempotencyStorePort,
  NoopIdempotencyStore,
  buildIdempotencyKey,
} from "../ports/idempotency-store.port.js";
import { type MemoryStorePort, NoopMemoryStore } from "../ports/memory-store.port.js";
import type { ModelContext, ModelMessage, ModelPort } from "../ports/model.port.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import { NoopSummarizer, type SummarizerPort } from "../ports/summarizer.port.js";
import type { ToolCallError, ToolRegistryPort } from "../ports/tool-registry.port.js";
import { BudgetEnforcer } from "./budget-enforcer.js";
import { type ContextBudget, ContextHydrator, DEFAULT_CONTEXT_BUDGET } from "./context-hydrator.js";
import { reconstructConversation } from "./conversation-replay.js";
import { LoopDetector } from "./loop-detector.js";
import {
  type HarnessMiddleware,
  compose,
  withEventEmission,
  withLoopDetection,
  withTiming,
} from "./middleware.js";
import { isDangerous, type ToolPolicy } from "./tool-policy.js";
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
  /**
   * Memory store for context hydration (T09).
   * Holds persistent facts and summaries injected into each model context.
   * Defaults to NoopMemoryStore (no facts or summaries).
   */
  memoryStore?: MemoryStorePort;
  /**
   * Summarizer for compressing evicted history (T09).
   * Called when evictedMessages.length >= contextBudget.summarizationThreshold.
   * Defaults to NoopSummarizer (placeholder — no model call).
   */
  summarizer?: SummarizerPort;
  /**
   * Token budget per context section (T09).
   * Defaults to DEFAULT_CONTEXT_BUDGET (11 500 tokens total).
   */
  contextBudget?: ContextBudget;

  // --- T12: Human-in-the-loop ---

  /**
   * Durable store for approval requests and decisions (T12).
   * Required when any tool in the registry may trigger requireApproval.
   * Defaults to NoopApprovalStore which throws on save/decide.
   */
  approvalStore?: ApprovalStorePort;
  /**
   * Policy evaluated before each tool call to decide whether approval is needed (T12).
   * "requireApproval" → suspend and wait for human confirmation.
   * "deny"            → block execution immediately.
   * "allow"           → proceed normally.
   * Defaults to isDangerous() — requireApproval for dangerous: true tools.
   */
  approvalPolicy?: ToolPolicy;
  /**
   * How long an approval request is valid before it expires (T12).
   * After expiry the defaultApprovalAction is taken automatically.
   * Defaults to 24 hours.
   */
  approvalTimeoutMs?: number;
  /**
   * Action taken when the approval deadline expires without a human decision (T12).
   * Defaults to "reject" — fail safe: do nothing when nobody responds.
   */
  approvalDefaultAction?: "approve" | "reject";
}

/** Thrown by resume() / resumeWithDecision() when the workflow does not exist. */
export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Workflow '${workflowId}' not found in state store`);
    this.name = "WorkflowNotFoundError";
  }
}

/** Thrown by resumeWithDecision() when the workflow is not in suspended status. */
export class WorkflowNotSuspendedError extends Error {
  constructor(workflowId: string, actualStatus: string) {
    super(`Workflow '${workflowId}' is not suspended (current status: ${actualStatus})`);
    this.name = "WorkflowNotSuspendedError";
  }
}

/** Thrown by resumeWithDecision() when no pending approval request is found. */
export class ApprovalRequestNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`No pending approval request found for workflow '${workflowId}'`);
    this.name = "ApprovalRequestNotFoundError";
  }
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    const memoryStore: MemoryStorePort = this.deps.memoryStore ?? new NoopMemoryStore();
    const summarizer: SummarizerPort = this.deps.summarizer ?? new NoopSummarizer();
    const contextBudget: ContextBudget = this.deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const approvalStore: ApprovalStorePort = this.deps.approvalStore ?? new NoopApprovalStore();
    const approvalPolicy: ToolPolicy = this.deps.approvalPolicy ?? isDangerous();
    const approvalTimeoutMs: number = this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const hydrator = new ContextHydrator();

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

    // Full conversation history (grows throughout the workflow).
    // The hydrator selects a pruned subset before each model call.
    const messages: ModelMessage[] = [{ role: "user", content: task.goal }];

    const enforcer = new BudgetEnforcer(task.budget);
    const detector = new LoopDetector();

    // Build terminal middleware: apply approval policy then execute the tool.
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

      // --- Approval policy gate ---
      // Evaluated here (not in the decorator chain) so resumeWithDecision() can
      // bypass the check for approved calls by using a dedicated executeTool variant.
      const decision = approvalPolicy.evaluate(input.args, executor.definition);
      if (decision === "deny") {
        ctx.bag.error = {
          code: "POLICY_DENIED",
          message: `Tool '${input.toolName}' is not permitted by the current policy.`,
          hint: "Use a different tool or request the operation through the appropriate channel.",
          retryable: false,
        };
        return;
      }
      if (decision === "requireApproval") {
        ctx.bag.error = {
          code: "APPROVAL_REQUIRED",
          message: `Tool '${input.toolName}' requires human approval before it can be executed.`,
          hint: "The workflow will be suspended until a human approves or rejects this action.",
          retryable: false,
        };
        // Signal withEventEmission to skip emitting tool.failed — the runtime will
        // emit approval.requested + workflow.suspended after the chain.
        ctx.bag.suspendForApproval = true;
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

      // --- Plan: hydrate context and call the model ---
      const toolSchemas = toolRegistry.schemas().map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }));

      const facts = await memoryStore.getFacts(workflowId);
      const summaries = await memoryStore.getSummaries(workflowId);
      const hydratedCtx = hydrator.build({
        systemPrompt: SYSTEM_PROMPT,
        tools: toolSchemas,
        history: messages,
        facts,
        summaries,
        budget: contextBudget,
      });

      // If messages were evicted and the threshold is reached, summarize them.
      if (hydratedCtx.evictedMessages.length >= contextBudget.summarizationThreshold) {
        const summaryContent = await summarizer.summarize(workflowId, hydratedCtx.evictedMessages);
        const summaryId = idPort.newId();
        const seqAnchor = state.seq;

        await memoryStore.addSummary(workflowId, {
          id: summaryId,
          fromSeq: seqAnchor,
          toSeq: seqAnchor,
          content: summaryContent,
          messageCount: hydratedCtx.evictedMessages.length,
          createdAt: clock.nowIso(),
        });

        const summarizedEvent: ContextSummarizedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "context.summarized",
          payload: {
            summaryId,
            fromSeq: seqAnchor,
            toSeq: seqAnchor,
            messageCount: hydratedCtx.evictedMessages.length,
            summary: summaryContent,
          },
        };
        await eventLog.append(summarizedEvent);
        state = reduce(state, summarizedEvent);
      }

      // Emit context.hydrated — token breakdown per section, visible in inspector.
      const hydratedEvent: ContextHydratedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "context.hydrated",
        payload: {
          tokensBySection: hydratedCtx.metadata.tokensBySection,
          totalTokens: hydratedCtx.metadata.totalTokens,
          prefixHash: hydratedCtx.metadata.prefixHash,
          evictedCount: hydratedCtx.metadata.evictedCount,
        },
      };
      await eventLog.append(hydratedEvent);
      state = reduce(state, hydratedEvent);

      const modelCtx: ModelContext = {
        messages: hydratedCtx.messages,
        tools: toolSchemas,
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

        // If approval is required, suspend the workflow and stop processing.
        // bag.emittedEvents contains only tool.called (withEventEmission skipped tool.failed).
        if (bag.suspendForApproval) {
          // Apply the tool.called event to state so seq is correct.
          for (const evt of bag.emittedEvents) {
            state = reduce(state, evt);
          }

          const requestId = idPort.newId();
          const resumeToken = idPort.newId();
          const expiresAt = new Date(clock.now() + approvalTimeoutMs).toISOString();

          const approvalReqEvent: ApprovalRequestedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "approval.requested",
            payload: {
              requestId,
              toolName: input.toolName,
              args: input.args,
              reason: bag.error?.message ?? "Tool requires human approval",
              expiresAt,
              stepId,
              callId: toolCall.id,
            },
          };
          await eventLog.append(approvalReqEvent);
          state = reduce(state, approvalReqEvent);

          const suspendedEvent: WorkflowSuspendedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "workflow.suspended",
            payload: {
              reason: `Tool '${input.toolName}' requires human approval`,
              resumeToken,
            },
          };
          await eventLog.append(suspendedEvent);
          state = reduce(state, suspendedEvent);
          await stateStore.save(workflowId, state, storeVersion++);

          // Persist the approval request so resumeWithDecision() can find it.
          await approvalStore.save({
            requestId,
            workflowId,
            stepId,
            callId: toolCall.id,
            resumeToken,
            toolName: input.toolName,
            args: input.args,
            reason: bag.error?.message ?? "Tool requires human approval",
            expiresAt,
            status: "pending",
          });

          running = false;
          break;
        }

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
    const memoryStore: MemoryStorePort = this.deps.memoryStore ?? new NoopMemoryStore();
    const summarizer: SummarizerPort = this.deps.summarizer ?? new NoopSummarizer();
    const contextBudget: ContextBudget = this.deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const approvalStore: ApprovalStorePort = this.deps.approvalStore ?? new NoopApprovalStore();
    const approvalPolicy: ToolPolicy = this.deps.approvalPolicy ?? isDangerous();
    const approvalTimeoutMs: number = this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const hydrator = new ContextHydrator();

    // --- Load state ---
    const versioned = await stateStore.load(workflowId);
    if (!versioned) {
      throw new WorkflowNotFoundError(workflowId);
    }
    let { state } = versioned;
    let storeVersion = versioned.version;

    // --- Reconstruct conversation from event log ---
    // Done before the terminal check so that memory store is always repopulated,
    // allowing callers to inspect summaries even for completed workflows.
    const events = await eventLog.read(workflowId);

    // Cache-Aside: repopulate MemoryStore from context.summarized events.
    // This ensures that a fresh MemoryStore (new process after crash) gets all
    // summaries without calling the Summarizer again (cost = 0).
    for (const evt of events) {
      if (evt.type === "context.summarized") {
        await memoryStore.addSummary(workflowId, {
          id: evt.payload.summaryId,
          fromSeq: evt.payload.fromSeq,
          toSeq: evt.payload.toSeq,
          content: evt.payload.summary,
          messageCount: evt.payload.messageCount,
          createdAt: evt.at,
        });
      }
    }

    // --- Already terminal or suspended: nothing to resume via crash-recovery ---
    // Suspended workflows require resumeWithDecision(), not plain resume().
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "halted" ||
      state.status === "suspended"
    ) {
      return state;
    }

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

      // --- Approval policy gate (same logic as in run()) ---
      const decision = approvalPolicy.evaluate(input.args, executor.definition);
      if (decision === "deny") {
        ctx.bag.error = {
          code: "POLICY_DENIED",
          message: `Tool '${input.toolName}' is not permitted by the current policy.`,
          hint: "Use a different tool or request the operation through the appropriate channel.",
          retryable: false,
        };
        return;
      }
      if (decision === "requireApproval") {
        ctx.bag.error = {
          code: "APPROVAL_REQUIRED",
          message: `Tool '${input.toolName}' requires human approval before it can be executed.`,
          hint: "The workflow will be suspended until a human approves or rejects this action.",
          retryable: false,
        };
        ctx.bag.suspendForApproval = true;
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

      const toolSchemas = toolRegistry.schemas().map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }));

      const facts = await memoryStore.getFacts(workflowId);
      const summaries = await memoryStore.getSummaries(workflowId);
      const hydratedCtx = hydrator.build({
        systemPrompt: SYSTEM_PROMPT,
        tools: toolSchemas,
        history: messages,
        facts,
        summaries,
        budget: contextBudget,
      });

      if (hydratedCtx.evictedMessages.length >= contextBudget.summarizationThreshold) {
        const summaryContent = await summarizer.summarize(workflowId, hydratedCtx.evictedMessages);
        const summaryId = idPort.newId();
        const seqAnchor = state.seq;

        await memoryStore.addSummary(workflowId, {
          id: summaryId,
          fromSeq: seqAnchor,
          toSeq: seqAnchor,
          content: summaryContent,
          messageCount: hydratedCtx.evictedMessages.length,
          createdAt: clock.nowIso(),
        });

        const summarizedEvent: ContextSummarizedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "context.summarized",
          payload: {
            summaryId,
            fromSeq: seqAnchor,
            toSeq: seqAnchor,
            messageCount: hydratedCtx.evictedMessages.length,
            summary: summaryContent,
          },
        };
        await eventLog.append(summarizedEvent);
        state = reduce(state, summarizedEvent);
      }

      const hydratedEvent: ContextHydratedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "context.hydrated",
        payload: {
          tokensBySection: hydratedCtx.metadata.tokensBySection,
          totalTokens: hydratedCtx.metadata.totalTokens,
          prefixHash: hydratedCtx.metadata.prefixHash,
          evictedCount: hydratedCtx.metadata.evictedCount,
        },
      };
      await eventLog.append(hydratedEvent);
      state = reduce(state, hydratedEvent);

      const modelCtx: ModelContext = {
        messages: hydratedCtx.messages,
        tools: toolSchemas,
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

        // Handle suspension (same logic as run()).
        if (bag.suspendForApproval) {
          for (const evt of bag.emittedEvents) {
            state = reduce(state, evt);
          }
          const requestId = idPort.newId();
          const resumeToken = idPort.newId();
          const expiresAt = new Date(clock.now() + approvalTimeoutMs).toISOString();

          const approvalReqEvent: ApprovalRequestedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "approval.requested",
            payload: {
              requestId,
              toolName: input.toolName,
              args: input.args,
              reason: bag.error?.message ?? "Tool requires human approval",
              expiresAt,
              stepId,
              callId: toolCall.id,
            },
          };
          await eventLog.append(approvalReqEvent);
          state = reduce(state, approvalReqEvent);

          const suspendedEvent: WorkflowSuspendedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "workflow.suspended",
            payload: {
              reason: `Tool '${input.toolName}' requires human approval`,
              resumeToken,
            },
          };
          await eventLog.append(suspendedEvent);
          state = reduce(state, suspendedEvent);
          await stateStore.save(workflowId, state, storeVersion++);

          await approvalStore.save({
            requestId,
            workflowId,
            stepId,
            callId: toolCall.id,
            resumeToken,
            toolName: input.toolName,
            args: input.args,
            reason: bag.error?.message ?? "Tool requires human approval",
            expiresAt,
            status: "pending",
          });

          running = false;
          break;
        }

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

  /**
   * resumeWithDecision — continue a suspended workflow after a human approval or rejection.
   *
   * Algorithm:
   *   1. Load state — must be "suspended".
   *   2. Find the pending ApprovalRequest for this workflow.
   *   3. Record the decision in the ApprovalStore.
   *   4a. Rejected: emit approval.rejected + workflow.failed. Return.
   *   4b. Approved: emit approval.granted + workflow.resumed.
   *   5. Reconstruct conversation. The approved tool call appears as an in-flight call
   *      (tool.called without tool.succeeded/failed in the log).
   *   6. Execute the approved tool call directly — policy check is intentionally skipped
   *      because the human has already authorised this invocation.
   *   7. Emit tool.succeeded / tool.failed and checkpoint.
   *   8. Continue the main run loop.
   *
   * @throws {WorkflowNotFoundError}    if workflowId is not in the state store.
   * @throws {WorkflowNotSuspendedError} if the workflow is not in "suspended" status.
   * @throws {ApprovalRequestNotFoundError} if no pending request exists for the workflow.
   */
  async resumeWithDecision(
    workflowId: string,
    response: ApprovalResponse,
  ): Promise<WorkflowState> {
    const { model, eventLog, stateStore, toolRegistry, clock, idPort, middleware } = this.deps;
    const idempotencyStore: IdempotencyStorePort =
      this.deps.idempotencyStore ?? new NoopIdempotencyStore();
    const memoryStore: MemoryStorePort = this.deps.memoryStore ?? new NoopMemoryStore();
    const summarizer: SummarizerPort = this.deps.summarizer ?? new NoopSummarizer();
    const contextBudget: ContextBudget = this.deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const approvalStore: ApprovalStorePort = this.deps.approvalStore ?? new NoopApprovalStore();
    const approvalPolicy: ToolPolicy = this.deps.approvalPolicy ?? isDangerous();
    const approvalTimeoutMs: number = this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const hydrator = new ContextHydrator();

    // --- Load and validate state ---
    const versioned = await stateStore.load(workflowId);
    if (!versioned) throw new WorkflowNotFoundError(workflowId);
    let { state } = versioned;
    let storeVersion = versioned.version;

    if (state.status !== "suspended") {
      throw new WorkflowNotSuspendedError(workflowId, state.status);
    }

    // --- Find the pending approval request ---
    const allRequests = await approvalStore.getByWorkflow(workflowId);
    const pendingRequest = allRequests.find((r) => r.status === "pending");
    if (!pendingRequest) throw new ApprovalRequestNotFoundError(workflowId);

    // --- Record the decision in the store ---
    await approvalStore.decide(pendingRequest.requestId, response);

    // --- Load events and repopulate memory store ---
    const events = await eventLog.read(workflowId);
    for (const evt of events) {
      if (evt.type === "context.summarized") {
        await memoryStore.addSummary(workflowId, {
          id: evt.payload.summaryId,
          fromSeq: evt.payload.fromSeq,
          toSeq: evt.payload.toSeq,
          content: evt.payload.summary,
          messageCount: evt.payload.messageCount,
          createdAt: evt.at,
        });
      }
    }

    // Fast-forward state to include events beyond the last checkpoint.
    const eventsAfterCheckpoint = events.filter((e) => e.seq > state.seq);
    for (const evt of eventsAfterCheckpoint) {
      state = reduce(state, evt);
    }

    if (response.decision === "rejected") {
      // --- Rejection path: emit approval.rejected then workflow.failed ---
      const rejectedEvent: ApprovalRejectedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "approval.rejected",
        payload: {
          requestId: pendingRequest.requestId,
          decidedBy: response.decidedBy,
          decidedAt: response.decidedAt,
          ...(response.comment !== undefined ? { reason: response.comment } : {}),
        },
      };
      await eventLog.append(rejectedEvent);
      state = reduce(state, rejectedEvent);

      const failedEvent: WorkflowFailedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "workflow.failed",
        payload: {
          code: "APPROVAL_REJECTED",
          message: `Tool '${pendingRequest.toolName}' was rejected by ${response.decidedBy}${response.comment ? `: ${response.comment}` : ""}`,
        },
      };
      await eventLog.append(failedEvent);
      state = reduce(state, failedEvent);
      await stateStore.save(workflowId, state, storeVersion++);
      return state;
    }

    // --- Approval path: emit approval.granted + workflow.resumed ---
    const grantedEvent: ApprovalGrantedEvent = {
      id: idPort.newId(),
      workflowId,
      seq: state.seq + 1,
      at: clock.nowIso(),
      type: "approval.granted",
      payload: {
        requestId: pendingRequest.requestId,
        decidedBy: response.decidedBy,
        decidedAt: response.decidedAt,
        ...(response.comment !== undefined ? { comment: response.comment } : {}),
      },
    };
    await eventLog.append(grantedEvent);
    state = reduce(state, grantedEvent);

    const resumedEvent: WorkflowResumedEvent = {
      id: idPort.newId(),
      workflowId,
      seq: state.seq + 1,
      at: clock.nowIso(),
      type: "workflow.resumed",
      payload: { resumeToken: pendingRequest.resumeToken },
    };
    await eventLog.append(resumedEvent);
    state = reduce(state, resumedEvent);
    await stateStore.save(workflowId, state, storeVersion++);

    // --- Reconstruct conversation ---
    // The approved tool call (callId = pendingRequest.callId) appears as an in-flight call.
    const allEventsAfterResume = await eventLog.read(workflowId);
    const { task, messages, inFlightCalls } = reconstructConversation(allEventsAfterResume);

    // --- Execute the approved in-flight tool call WITHOUT policy check ---
    // The human has already authorised this — re-checking the policy would suspend again.
    for (const call of inFlightCalls) {
      const executor = toolRegistry.get(call.toolName);
      if (!executor) {
        const failedEvent: ToolFailedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "tool.failed",
          payload: {
            stepId: call.stepId,
            callId: call.callId,
            code: "TOOL_NOT_FOUND",
            message: `Tool '${call.toolName}' not found during approval resume`,
            retryable: false,
          },
        };
        await eventLog.append(failedEvent);
        state = reduce(state, failedEvent);
        messages.push({
          role: "tool",
          content: JSON.stringify({ ok: false, code: "TOOL_NOT_FOUND" }),
          toolCallId: call.callId,
          name: call.toolName,
        });
        continue;
      }

      // Execute directly — policy check intentionally omitted (approved by human).
      const execResult = await executor.execute(call.args);
      if (execResult.ok) {
        await idempotencyStore.set(
          buildIdempotencyKey(workflowId, call.seq, call.toolName),
          execResult.value,
        );
        const succeededEvent: ToolSucceededEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "tool.succeeded",
          payload: {
            stepId: call.stepId,
            callId: call.callId,
            result: execResult.value,
            durationMs: 0,
          },
        };
        await eventLog.append(succeededEvent);
        state = reduce(state, succeededEvent);
        messages.push({
          role: "tool",
          content: JSON.stringify({ ok: true, result: execResult.value }),
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
            code: execResult.error.code,
            message: execResult.error.message,
            retryable: execResult.error.retryable,
          },
        };
        await eventLog.append(failedEvent);
        state = reduce(state, failedEvent);
        messages.push({
          role: "tool",
          content: JSON.stringify({ ok: false, ...execResult.error }),
          toolCallId: call.callId,
          name: call.toolName,
        });
      }
    }

    // Checkpoint after executing the approved call.
    const postApprovalCheckpoint: StateCheckpointedEvent = {
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
    await eventLog.append(postApprovalCheckpoint);
    state = reduce(state, postApprovalCheckpoint);
    await stateStore.save(workflowId, state, storeVersion++);

    // --- Continue the main loop after the approved tool call ---
    const enforcer = new BudgetEnforcer(task.budget);
    const detector = new LoopDetector();

    // executeTool for the continuation: applies policy (new tool calls after this point
    // may themselves require approval) and idempotency.
    const executeToolAfterApproval: HarnessMiddleware = async (ctx, _next) => {
      const input = ctx.step.input as ToolCallInput;
      const executor = toolRegistry.get(input.toolName);
      if (!executor) {
        const available = toolRegistry.list().map((e) => e.definition.name).join(", ");
        ctx.bag.error = {
          code: "TOOL_NOT_FOUND",
          message: `Tool '${input.toolName}' is not registered. Available tools: ${available || "none"}`,
          retryable: false,
        };
        return;
      }

      const decision = approvalPolicy.evaluate(input.args, executor.definition);
      if (decision === "deny") {
        ctx.bag.error = {
          code: "POLICY_DENIED",
          message: `Tool '${input.toolName}' is not permitted by the current policy.`,
          hint: "Use a different tool or request the operation through the appropriate channel.",
          retryable: false,
        };
        return;
      }
      if (decision === "requireApproval") {
        ctx.bag.error = {
          code: "APPROVAL_REQUIRED",
          message: `Tool '${input.toolName}' requires human approval before it can be executed.`,
          hint: "The workflow will be suspended until a human approves or rejects this action.",
          retryable: false,
        };
        ctx.bag.suspendForApproval = true;
        return;
      }

      const iKey = buildIdempotencyKey(workflowId, ctx.bag.nextSeq, input.toolName);
      const cached = await idempotencyStore.get(iKey);
      if (cached !== undefined) {
        ctx.bag.result = cached;
        return;
      }

      const execResult = await executor.execute(input.args);
      if (execResult.ok) {
        ctx.bag.result = execResult.value;
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
      executeToolAfterApproval,
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

      const toolSchemas = toolRegistry.schemas().map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }));

      const facts = await memoryStore.getFacts(workflowId);
      const summaries = await memoryStore.getSummaries(workflowId);
      const hydratedCtx = hydrator.build({
        systemPrompt: SYSTEM_PROMPT,
        tools: toolSchemas,
        history: messages,
        facts,
        summaries,
        budget: contextBudget,
      });

      if (hydratedCtx.evictedMessages.length >= contextBudget.summarizationThreshold) {
        const summaryContent = await summarizer.summarize(workflowId, hydratedCtx.evictedMessages);
        const summaryId = idPort.newId();
        const seqAnchor = state.seq;

        await memoryStore.addSummary(workflowId, {
          id: summaryId,
          fromSeq: seqAnchor,
          toSeq: seqAnchor,
          content: summaryContent,
          messageCount: hydratedCtx.evictedMessages.length,
          createdAt: clock.nowIso(),
        });

        const summarizedEvent: ContextSummarizedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "context.summarized",
          payload: {
            summaryId,
            fromSeq: seqAnchor,
            toSeq: seqAnchor,
            messageCount: hydratedCtx.evictedMessages.length,
            summary: summaryContent,
          },
        };
        await eventLog.append(summarizedEvent);
        state = reduce(state, summarizedEvent);
      }

      const hydratedEvent: ContextHydratedEvent = {
        id: idPort.newId(),
        workflowId,
        seq: state.seq + 1,
        at: clock.nowIso(),
        type: "context.hydrated",
        payload: {
          tokensBySection: hydratedCtx.metadata.tokensBySection,
          totalTokens: hydratedCtx.metadata.totalTokens,
          prefixHash: hydratedCtx.metadata.prefixHash,
          evictedCount: hydratedCtx.metadata.evictedCount,
        },
      };
      await eventLog.append(hydratedEvent);
      state = reduce(state, hydratedEvent);

      const modelCtx: ModelContext = {
        messages: hydratedCtx.messages,
        tools: toolSchemas,
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

      const resumeResponse = modelResult.value;

      const updatedBudget = {
        ...state.budget,
        tokensUsed: state.budget.tokensUsed + resumeResponse.usage.totalTokens,
        wallClockMs: clock.now() - startMs,
      };
      state = { ...state, budget: updatedBudget };

      if (resumeResponse.toolCalls.length === 0 || resumeResponse.finishReason === "stop") {
        const completedEvent: WorkflowCompletedEvent = {
          id: idPort.newId(),
          workflowId,
          seq: state.seq + 1,
          at: clock.nowIso(),
          type: "workflow.completed",
          payload: {
            result: resumeResponse.content,
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
        content: resumeResponse.content,
        toolCalls: [...resumeResponse.toolCalls],
      });

      for (const toolCall of resumeResponse.toolCalls) {
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

        if (bag.suspendForApproval) {
          for (const evt of bag.emittedEvents) {
            state = reduce(state, evt);
          }
          const requestId = idPort.newId();
          const resumeToken = idPort.newId();
          const expiresAt = new Date(clock.now() + approvalTimeoutMs).toISOString();

          const approvalReqEvent: ApprovalRequestedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "approval.requested",
            payload: {
              requestId,
              toolName: input.toolName,
              args: input.args,
              reason: bag.error?.message ?? "Tool requires human approval",
              expiresAt,
              stepId,
              callId: toolCall.id,
            },
          };
          await eventLog.append(approvalReqEvent);
          state = reduce(state, approvalReqEvent);

          const suspendedEvent: WorkflowSuspendedEvent = {
            id: idPort.newId(),
            workflowId,
            seq: state.seq + 1,
            at: clock.nowIso(),
            type: "workflow.suspended",
            payload: {
              reason: `Tool '${input.toolName}' requires human approval`,
              resumeToken,
            },
          };
          await eventLog.append(suspendedEvent);
          state = reduce(state, suspendedEvent);
          await stateStore.save(workflowId, state, storeVersion++);

          await approvalStore.save({
            requestId,
            workflowId,
            stepId,
            callId: toolCall.id,
            resumeToken,
            toolName: input.toolName,
            args: input.args,
            reason: bag.error?.message ?? "Tool requires human approval",
            expiresAt,
            status: "pending",
          });

          running = false;
          break;
        }

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
