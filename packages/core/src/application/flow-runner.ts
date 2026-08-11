import type { Budget, HarnessEvent } from "@harness/contracts";
import type { AgentRegistryPort } from "../ports/agent-registry.port.js";
import type { ClockPort } from "../ports/clock.port.js";
import type { EventLogPort } from "../ports/event-log.port.js";
import type { IdPort } from "../ports/id.port.js";
import type { ModelPort } from "../ports/model.port.js";
import type { StateStorePort } from "../ports/state-store.port.js";
import type { SubagentTask } from "../ports/supervisor.port.js";
import type { SupervisorPort } from "../ports/supervisor.port.js";
import type { ToolRegistryPort } from "../ports/tool-registry.port.js";
import { HarnessRuntime } from "./harness-runtime.js";
import type { HarnessMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// FlowSpec — declarative descriptor for a named multi-agent orchestration
//
// A flow defines a coordinated pipeline of specialist agents. Each agent step
// receives its own filtered tool registry (least-privilege) and runs as an
// independent HarnessRuntime. The flow runner coordinates them via the
// Supervisor (parallel) or in explicit order (sequential).
//
// Design principle: flows are DATA — no business logic lives here. The runner
// is a pure interpreter that executes whatever spec it is given. New flows are
// added by extending DEFAULT_FLOWS, not by subclassing the runner.
// ---------------------------------------------------------------------------

/**
 * FlowAgentStep — one specialist's contribution to the flow.
 *
 * `goalTemplate` may contain `{{goal}}` which is replaced with the
 * user-provided goal string at runtime. This lets the flow steer each
 * specialist while preserving the original context.
 */
export interface FlowAgentStep {
  /** Must match an AgentSpec.name in the AgentRegistryPort. */
  agentName: string;
  /** Template for this agent's task goal. Use {{goal}} for the user's input. */
  goalTemplate: string;
}

/**
 * FlowSpec — full descriptor for a named orchestration flow.
 *
 * - `parallel`: all agents run concurrently via Supervisor.fanOut.
 *   Use when agents work on independent aspects of the same goal.
 * - `sequential`: agents run in order; each receives the previous
 *   agent's result appended to its goal (context carry-forward).
 *   Use when later steps depend on earlier outputs.
 */
export interface FlowSpec {
  /** Unique slug used in API URLs: POST /flows/:id/run */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** One-sentence description of what the flow produces. */
  description: string;
  /** "parallel" = Supervisor fan-out; "sequential" = ordered pipeline. */
  pattern: "parallel" | "sequential";
  /** Ordered list of agent steps. In parallel flows, order is cosmetic only. */
  steps: readonly FlowAgentStep[];
}

// ---------------------------------------------------------------------------
// FlowRunResult
// ---------------------------------------------------------------------------

export interface FlowStepOutcome {
  stepId: string;
  agentName: string;
  workflowId: string;
  status: "success" | "failed";
  result?: string;
  reason?: string;
}

export interface FlowRunResult {
  flowId: string;
  pattern: "parallel" | "sequential";
  /** Parent workflow ID used for fan-out event grouping. */
  parentWorkflowId: string;
  /** One entry per FlowAgentStep, in definition order. */
  steps: FlowStepOutcome[];
  partial: boolean;
}

// ---------------------------------------------------------------------------
// FlowRunnerDeps
// ---------------------------------------------------------------------------

export interface FlowRunnerDeps {
  agentRegistry: AgentRegistryPort;
  /** Full tool registry — FlowRunner creates per-agent filtered views. */
  toolRegistry: ToolRegistryPort;
  supervisor: SupervisorPort;
  model: ModelPort;
  eventLog: EventLogPort;
  stateStore: StateStorePort;
  clock: ClockPort;
  idPort: IdPort;
  middleware: readonly HarnessMiddleware[];
  livePublish?: (event: HarnessEvent) => void;
}

// ---------------------------------------------------------------------------
// FlowRunner
// ---------------------------------------------------------------------------

/**
 * FlowRunner — interprets a FlowSpec and orchestrates specialist agents.
 *
 * Pattern: Interpreter — the spec is the DSL, the runner is the engine.
 *
 * For parallel flows, it delegates to Supervisor.fanOut so each agent
 * benefits from budget distribution, per-task timeouts, and abort propagation.
 *
 * For sequential flows, it chains HarnessRuntime.run() calls in order,
 * prepending the previous agent's result text to the next agent's goal.
 */
export class FlowRunner {
  constructor(private readonly deps: FlowRunnerDeps) {}

  async run(
    spec: FlowSpec,
    userGoal: string,
    budget: Budget,
    signal?: AbortSignal,
  ): Promise<FlowRunResult> {
    const parentWorkflowId = this.deps.idPort.newId();

    if (spec.pattern === "parallel") {
      return this.runParallel(spec, userGoal, budget, parentWorkflowId, signal);
    }
    return this.runSequential(spec, userGoal, budget, parentWorkflowId, signal);
  }

  // ---------------------------------------------------------------------------
  // Parallel execution via Supervisor.fanOut
  // ---------------------------------------------------------------------------

  private async runParallel(
    spec: FlowSpec,
    userGoal: string,
    budget: Budget,
    parentWorkflowId: string,
    signal?: AbortSignal,
  ): Promise<FlowRunResult> {
    // Divide budget equally so parallel agents can't collectively exceed the caller's limits.
    const stepCount = Math.max(1, spec.steps.length);
    const stepBudget: Budget = {
      ...budget,
      maxTokens: Math.floor(budget.maxTokens / stepCount),
      maxCostUsd: budget.maxCostUsd / stepCount,
    };

    const tasks: SubagentTask<FlowStepOutcome>[] = spec.steps.map((step, i) => {
      const workflowId = this.deps.idPort.newId();
      const goal = step.goalTemplate.replace(/\{\{goal\}\}/g, userGoal);
      const stepId = `${step.agentName}:${i}`;

      return {
        taskId: `${spec.id}:${stepId}`,
        execute: async (): Promise<FlowStepOutcome> => {
          const runtime = this.buildRuntime(step.agentName);
          try {
            const state = await runtime.run({
              id: workflowId,
              goal,
              budget: stepBudget,
              metadata: { flowId: spec.id, parentWorkflowId, stepIndex: i },
            });
            // HarnessRuntime.run() returns a state rather than throwing on agent failures.
            // Check the terminal status explicitly so a failed/halted agent is not reported
            // as a successful step.
            if (state.status === "failed" || state.status === "halted") {
              return {
                stepId,
                agentName: step.agentName,
                workflowId,
                status: "failed",
                reason: state.error ?? `Agent ended with status "${state.status}"`,
              };
            }
            const outcome: FlowStepOutcome = {
              stepId,
              agentName: step.agentName,
              workflowId,
              status: "success",
            };
            if (typeof state.result === "string") outcome.result = state.result;
            return outcome;
          } catch (err) {
            return {
              stepId,
              agentName: step.agentName,
              workflowId,
              status: "failed",
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        },
      };
    });

    const fanOutOpts =
      signal !== undefined ? { parentBudget: budget, signal } : { parentBudget: budget };
    const fanOut = await this.deps.supervisor.fanOut(tasks, fanOutOpts);

    const steps: FlowStepOutcome[] = fanOut.results.map((r) => {
      if (r.status === "success") return r.value;
      const parts = r.taskId.split(":");
      return {
        stepId: r.taskId,
        agentName: parts[1] ?? "unknown",
        workflowId: "",
        status: "failed" as const,
        reason: r.reason,
      };
    });

    return {
      flowId: spec.id,
      pattern: "parallel",
      parentWorkflowId,
      steps,
      partial: fanOut.partial,
    };
  }

  // ---------------------------------------------------------------------------
  // Sequential execution with context carry-forward
  // ---------------------------------------------------------------------------

  private async runSequential(
    spec: FlowSpec,
    userGoal: string,
    budget: Budget,
    parentWorkflowId: string,
    signal?: AbortSignal,
  ): Promise<FlowRunResult> {
    const steps: FlowStepOutcome[] = [];
    // Divide budget equally across steps.
    const stepCount = Math.max(1, spec.steps.length);
    const stepBudget: Budget = {
      ...budget,
      maxTokens: Math.floor(budget.maxTokens / stepCount),
      maxCostUsd: budget.maxCostUsd / stepCount,
    };

    let carryForward = "";

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      if (step === undefined) continue;

      if (signal?.aborted) {
        steps.push({
          stepId: `${step.agentName}:${i}`,
          agentName: step.agentName,
          workflowId: "",
          status: "failed",
          reason: "Flow aborted before this step",
        });
        continue;
      }

      const workflowId = this.deps.idPort.newId();
      const base = step.goalTemplate.replace(/\{\{goal\}\}/g, userGoal);
      const goal = carryForward ? `${base}\n\nContext from previous step:\n${carryForward}` : base;

      const runtime = this.buildRuntime(step.agentName);
      try {
        const state = await runtime.run({
          id: workflowId,
          goal,
          budget: stepBudget,
          metadata: { flowId: spec.id, parentWorkflowId, stepIndex: i },
        });

        // HarnessRuntime.run() returns a state rather than throwing on agent failures.
        // Treat failed/halted terminal states as step failures so downstream steps
        // don't receive stale carry-forward context from a broken agent.
        if (state.status === "failed" || state.status === "halted") {
          steps.push({
            stepId: `${step.agentName}:${i}`,
            agentName: step.agentName,
            workflowId,
            status: "failed",
            reason: state.error ?? `Agent ended with status "${state.status}"`,
          });
          break;
        }

        const resultText = typeof state.result === "string" ? state.result : undefined;
        carryForward = resultText ?? "";

        const outcome: FlowStepOutcome = {
          stepId: `${step.agentName}:${i}`,
          agentName: step.agentName,
          workflowId,
          status: "success",
        };
        if (resultText !== undefined) outcome.result = resultText;
        steps.push(outcome);
      } catch (err) {
        steps.push({
          stepId: `${step.agentName}:${i}`,
          agentName: step.agentName,
          workflowId,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        // Sequential flows stop on first failure.
        break;
      }
    }

    const partial = steps.some((s) => s.status === "failed");
    return { flowId: spec.id, pattern: "sequential", parentWorkflowId, steps, partial };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildRuntime(agentName: string): HarnessRuntime {
    const agentSpec = this.deps.agentRegistry.get(agentName);
    const toolRegistry = agentSpec
      ? buildFilteredRegistry(this.deps.toolRegistry, agentSpec.toolNames)
      : this.deps.toolRegistry;

    const rtDeps = {
      model: this.deps.model,
      eventLog: this.deps.eventLog,
      stateStore: this.deps.stateStore,
      toolRegistry,
      clock: this.deps.clock,
      idPort: this.deps.idPort,
      middleware: this.deps.middleware,
    };

    if (this.deps.livePublish !== undefined) {
      return new HarnessRuntime({ ...rtDeps, livePublish: this.deps.livePublish });
    }
    return new HarnessRuntime(rtDeps);
  }
}

// ---------------------------------------------------------------------------
// buildFilteredRegistry — inline projection (no adapters-memory import)
// ---------------------------------------------------------------------------

function buildFilteredRegistry(
  inner: ToolRegistryPort,
  allowedNames: readonly string[],
): ToolRegistryPort {
  const allowed = new Set(allowedNames);
  return {
    register() {
      throw new Error("Filtered registry is read-only.");
    },
    get(name) {
      return allowed.has(name) ? inner.get(name) : undefined;
    },
    list() {
      return inner.list().filter((e) => allowed.has(e.definition.name));
    },
    schemas() {
      return inner
        .list()
        .filter((e) => allowed.has(e.definition.name))
        .map((e) => e.definition);
    },
  };
}
