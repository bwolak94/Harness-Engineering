import type { Budget, BudgetExceeded, HarnessEvent } from "@harness/contracts";
import type { WorkflowState } from "../domain/workflow-state.js";
import type { ClockPort } from "../ports/clock.port.js";
import type { EventLogPort } from "../ports/event-log.port.js";
import type { IdPort } from "../ports/id.port.js";
import type { ToolCallError } from "../ports/tool-registry.port.js";
import type { ToolRegistryPort } from "../ports/tool-registry.port.js";

/**
 * ToolCallInput — typed input for a tool-call step.
 * Placed inside Step.input for tool_call kind.
 * Must be JSON-serialisable (prerequisite for durable execution in T07).
 */
export interface ToolCallInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly callId: string;
}

/**
 * Step — a serialisable command describing a single unit of work.
 *
 * Deliberately a plain data object, never a closure. This makes steps
 * storable, replayable and transmissible to the inspector UI.
 */
export interface Step {
  readonly stepId: string;
  readonly kind: "tool_call" | "llm_turn" | "handoff";
  readonly input: unknown;
  readonly meta?: Record<string, unknown>;
}

/**
 * StepBag — mutable communication channel shared across the middleware chain.
 *
 * Each layer may read what earlier layers wrote and write data for later layers.
 * Using null (not undefined) for absent values to be compatible with
 * exactOptionalPropertyTypes.
 */
export interface StepBag {
  /** Result of tool execution (set by terminal middleware on success). */
  result: unknown;
  /** Error from tool execution (set by terminal middleware on failure). */
  error: ToolCallError | null;
  /** Duration of the core tool call in milliseconds (set by withTiming). */
  durationMs: number;
  /** Epoch ms when this step started (set by withTiming before next()). */
  startedAt: number;
  /** Loop-detection corrective message to inject into the conversation. */
  correctiveMessage: string | null;
  /** Set by withBudget if a limit is already exceeded — signals the runtime to halt. */
  budgetExceeded: BudgetExceeded | null;
  /** Events emitted during this step (accumulated by withEventEmission). */
  emittedEvents: HarnessEvent[];
  /** Next seq number for events emitted inside this step. Incremented by withEventEmission. */
  nextSeq: number;
}

/**
 * StepContext — everything the middleware chain and terminal executor need
 * to process a single step. Constructed fresh by the runtime per tool call.
 */
export interface StepContext {
  readonly step: Step;
  readonly workflowId: string;
  /** Budget limits for this workflow run (from the originating TaskPacket). */
  readonly budget: Budget;
  /** Workflow state snapshot at the moment this context was created. */
  readonly state: WorkflowState;
  readonly eventLog: EventLogPort;
  readonly toolRegistry: ToolRegistryPort;
  readonly clock: ClockPort;
  readonly idPort: IdPort;
  /** Mutable bag — the only mutable part of the context. */
  readonly bag: StepBag;
}

/** Create a fresh StepBag initialised to safe defaults. */
export function createStepBag(nextSeq: number): StepBag {
  return {
    result: null,
    error: null,
    durationMs: 0,
    startedAt: 0,
    correctiveMessage: null,
    budgetExceeded: null,
    emittedEvents: [],
    nextSeq,
  };
}
