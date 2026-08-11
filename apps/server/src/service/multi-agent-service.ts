import { FilteredToolRegistry } from "@harness/adapters-memory";
import type { Budget, HarnessEvent } from "@harness/contracts";
import type {
  EventLogPort,
  HarnessRuntimeDeps,
  IdPort,
  StateStorePort,
  WorkflowState,
} from "@harness/core";
import { HarnessRuntime } from "@harness/core";
import type { AgentRegistryPort } from "@harness/core";
import type { RouterPort } from "@harness/core";

// ---------------------------------------------------------------------------
// MultiAgentService — routes a goal to the correct specialist and runs it
//
// Routing pipeline:
//   1. Router.route(goal) → RoutingDecision (rule-based → LLM → escalation)
//   2. AgentRegistry.get(targetAgent) → AgentSpec with allowed tool names
//   3. FilteredToolRegistry restricts the tool view to that agent's tools
//   4. A fresh HarnessRuntime runs with the filtered registry
//   5. The parent workflow emits agent.handoff before the child starts
//
// Escalation handling: if the Router cannot classify with sufficient confidence,
// it returns matchedBy:"escalation" with an empty targetAgent. The service
// falls back to running the goal with the FULL tool registry (best-effort).
// ---------------------------------------------------------------------------

export interface StartMultiAgentOptions {
  goal: string;
  budget?: Partial<Budget>;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface StartMultiAgentResult {
  workflowId: string;
  /** Name of the specialist agent selected, or "general" for escalation. */
  selectedAgent: string;
  routedBy: "rule" | "llm" | "escalation";
}

export interface MultiAgentServiceDeps {
  runtimeDeps: HarnessRuntimeDeps;
  eventLog: EventLogPort;
  stateStore: StateStorePort;
  idPort: IdPort;
  router: RouterPort;
  agentRegistry: AgentRegistryPort;
}

export class MultiAgentService {
  private readonly runtimeDeps: HarnessRuntimeDeps;
  private readonly eventLog: EventLogPort;
  private readonly stateStore: StateStorePort;
  private readonly idPort: IdPort;
  private readonly router: RouterPort;
  private readonly agentRegistry: AgentRegistryPort;

  private static readonly DEFAULT_BUDGET: Budget = {
    maxTokens: 100_000,
    maxSteps: 20,
    maxWallClockMs: 300_000,
    maxCostUsd: 5.0,
  };

  constructor(deps: MultiAgentServiceDeps) {
    this.runtimeDeps = deps.runtimeDeps;
    this.eventLog = deps.eventLog;
    this.stateStore = deps.stateStore;
    this.idPort = deps.idPort;
    this.router = deps.router;
    this.agentRegistry = deps.agentRegistry;
  }

  /**
   * Route a goal to the best-fit specialist agent and start the workflow.
   *
   * Fire-and-forget: returns the workflowId immediately. Routing is performed
   * inline (sub-millisecond for rule-based; one LLM call otherwise), so the
   * 202 response still arrives promptly before heavy computation starts.
   */
  start(opts: StartMultiAgentOptions): Promise<StartMultiAgentResult> {
    return this._startAsync(opts);
  }

  private async _startAsync(opts: StartMultiAgentOptions): Promise<StartMultiAgentResult> {
    const workflowId = this.idPort.newId();
    const budget: Budget = { ...MultiAgentService.DEFAULT_BUDGET, ...opts.budget };

    // --- Route the goal ---
    const decision = await this.router.route(opts.goal);

    // --- Resolve the agent spec (or fall back to "general" on escalation) ---
    const agentSpec =
      decision.matchedBy !== "escalation" && decision.targetAgent !== ""
        ? this.agentRegistry.get(decision.targetAgent)
        : undefined;

    const selectedAgent = agentSpec?.name ?? "general";

    // --- Build the tool registry for this agent ---
    const toolRegistry = agentSpec
      ? new FilteredToolRegistry(this.runtimeDeps.toolRegistry, agentSpec.toolNames)
      : this.runtimeDeps.toolRegistry;

    // --- Build runtime with the per-agent tool view ---
    const runtime = new HarnessRuntime({
      ...this.runtimeDeps,
      toolRegistry,
    });

    // --- Emit agent.handoff before the sub-agent starts ---
    const handoffEvent: HarnessEvent = {
      id: this.idPort.newId(),
      workflowId,
      seq: 1,
      at: new Date().toISOString(),
      type: "agent.handoff",
      payload: {
        fromAgent: "supervisor",
        toAgent: selectedAgent,
        reason: decision.reason,
        contextSlice: [],
      },
    } as HarnessEvent;

    await this.eventLog.append(handoffEvent);

    // --- Fire and forget the runtime ---
    const task = {
      id: workflowId,
      goal: opts.goal,
      budget,
      ...(opts.constraints !== undefined && { constraints: opts.constraints }),
      ...(opts.metadata !== undefined && { metadata: opts.metadata }),
    };

    void runtime.run(task).catch((err: unknown) => {
      console.error(`[multi-agent] unhandled runtime error for workflow ${workflowId}:`, err);
    });

    return { workflowId, selectedAgent, routedBy: decision.matchedBy };
  }

  /** Return the current workflow state, or undefined if not found. */
  async getState(workflowId: string): Promise<WorkflowState | undefined> {
    const versioned = await this.stateStore.load(workflowId);
    return versioned?.state;
  }

  /** Return all events for a workflow starting from fromSeq (inclusive). */
  async getEvents(workflowId: string, fromSeq = 0): Promise<readonly HarnessEvent[]> {
    return this.eventLog.read(workflowId, fromSeq);
  }
}
