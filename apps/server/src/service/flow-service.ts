import type { Budget } from "@harness/contracts";
import type {
  AgentRegistryPort,
  ClockPort,
  EventLogPort,
  FlowRunResult,
  FlowRunner,
  FlowSpec,
  HarnessMiddleware,
  IdPort,
  ModelPort,
  StateStorePort,
  SupervisorPort,
  ToolRegistryPort,
} from "@harness/core";

// ---------------------------------------------------------------------------
// FlowService — Facade that wires FlowRunner to HTTP controllers
//
// Provides list() for GET /flows and run() for POST /flows/:id/run.
// Flows are fire-and-forget for parallel patterns and awaited for sequential
// (the runner handles its own concurrency). The HTTP layer always gets the
// full FlowRunResult so it can forward child workflowIds to the client.
// ---------------------------------------------------------------------------

export interface FlowServiceDeps {
  flows: readonly FlowSpec[];
  flowRunner: FlowRunner;
}

export class FlowService {
  private readonly flows: ReadonlyMap<string, FlowSpec>;
  private readonly runner: FlowRunner;

  constructor(deps: FlowServiceDeps) {
    this.flows = new Map(deps.flows.map((f) => [f.id, f]));
    this.runner = deps.flowRunner;
  }

  /** Return all registered flows (for GET /flows). */
  list(): readonly FlowSpec[] {
    return [...this.flows.values()];
  }

  /** Look up a single flow by id. */
  get(id: string): FlowSpec | undefined {
    return this.flows.get(id);
  }

  /**
   * Execute a named flow and return the full result.
   *
   * Both parallel and sequential flows are awaited here — the HTTP handler
   * can return 202 immediately and the client subscribes via WS to child
   * workflow events. The FlowRunResult contains all child workflowIds.
   */
  async run(
    flowId: string,
    goal: string,
    budget?: Partial<Budget>,
    signal?: AbortSignal,
  ): Promise<FlowRunResult> {
    const spec = this.flows.get(flowId);
    if (!spec) throw new Error(`Flow '${flowId}' not found`);

    const resolvedBudget: Budget = {
      maxTokens: 100_000,
      maxSteps: 20,
      maxWallClockMs: 300_000,
      maxCostUsd: 5.0,
      ...budget,
    };

    return this.runner.run(spec, goal, resolvedBudget, signal);
  }
}

// ---------------------------------------------------------------------------
// FlowServiceDeps factory types (convenience for compose.ts)
// ---------------------------------------------------------------------------

export interface BuildFlowServiceOptions {
  flows: readonly FlowSpec[];
  agentRegistry: AgentRegistryPort;
  toolRegistry: ToolRegistryPort;
  supervisor: SupervisorPort;
  model: ModelPort;
  eventLog: EventLogPort;
  stateStore: StateStorePort;
  clock: ClockPort;
  idPort: IdPort;
  middleware: readonly HarnessMiddleware[];
  livePublish?: (event: import("@harness/contracts").HarnessEvent) => void;
}
