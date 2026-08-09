import type { FakeModelPort } from "@harness/adapters-memory";
import type { HarnessEvent, TaskPacket, WorkflowStatus } from "@harness/contracts";

// ---------------------------------------------------------------------------
// Eval case definition
// ---------------------------------------------------------------------------

/**
 * EvalCase — a single eval scenario.
 *
 * Uses FakeModelPort so every run is deterministic and free (no LLM calls).
 * Outcome checks validate the tool output. Trajectory checks validate the
 * shape of the execution path. Snapshot cases persist the event-type sequence
 * to detect unintentional runtime regressions (e.g. disabling budget guard).
 */
export interface EvalCase {
  /** Unique stable ID used for snapshot file naming. */
  id: string;
  /** Which tool this primarily exercises — for grouping in reports. */
  tool: string;
  /** Human-readable intent — printed in the markdown report. */
  description: string;
  task: TaskPacket;
  /** Scripted model — deterministic, no network. */
  model: FakeModelPort;
  /**
   * Assertions on the last tool.succeeded event's payload.result.
   * Only evaluated when at least one tool.succeeded event is present.
   */
  outcomeChecks: OutcomeCheck[];
  /** Assertions on the full event log and final workflow state. */
  trajectoryChecks: TrajectoryConstraint[];
  /**
   * When true, the ordered list of event *types* is saved to (and compared
   * against) a JSON snapshot file on disk. Detects structural regressions
   * without hardcoding exact field values.
   */
  snapshot?: boolean;
}

// ---------------------------------------------------------------------------
// Outcome checks (deterministic assertions on tool output)
// ---------------------------------------------------------------------------

/** Navigate a nested object using dot-path notation, e.g. "loan.amount". */
export type DotPath = string;

export type OutcomeCheck =
  /** Numeric field must be strictly greater than value. */
  | { type: "field_gt"; path: DotPath; value: number }
  /** Numeric field must be strictly less than value. */
  | { type: "field_lt"; path: DotPath; value: number }
  /** Numeric field must be within [min, max] inclusive. */
  | { type: "field_between"; path: DotPath; min: number; max: number }
  /** Field must deep-equal value. */
  | { type: "field_equals"; path: DotPath; value: unknown }
  /** Array field must have at least minLength elements. */
  | { type: "array_min_length"; path: DotPath; minLength: number }
  /** Field must be truthy (exists and is not null/undefined/false/0/""). */
  | { type: "field_truthy"; path: DotPath };

// ---------------------------------------------------------------------------
// Trajectory constraints (assertions on the execution path)
// ---------------------------------------------------------------------------

export type TrajectoryConstraint =
  /** Final workflow status must equal expected. */
  | { type: "status"; expected: WorkflowStatus }
  /** Total tool steps (tool.called events) must not exceed max. */
  | { type: "max_steps"; max: number }
  /** Total tool steps must be at least min. */
  | { type: "min_steps"; min: number }
  /** A tool with this name must have been called at least once. */
  | { type: "tool_called"; name: string }
  /** A tool with this name must NOT have been called. */
  | { type: "tool_not_called"; name: string }
  /**
   * No two tool.called events may share the same (toolName, args) combination.
   * Catches infinite loops in non-scripted model paths.
   */
  | { type: "no_repeated_tool_args" };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface OutcomeFailure {
  check: OutcomeCheck;
  message: string;
}

export interface TrajectoryFailure {
  constraint: TrajectoryConstraint;
  message: string;
}

export interface EvalResult {
  caseId: string;
  tool: string;
  description: string;
  passed: boolean;
  outcomeFailures: OutcomeFailure[];
  trajectoryFailures: TrajectoryFailure[];
  /** Diff string when snapshot mismatch is detected. Null if snapshot matched. */
  snapshotDiff: string | null;
  /** Number of tool.called events emitted during the run. */
  steps: number;
  durationMs: number;
  status: WorkflowStatus;
  events: HarnessEvent[];
}

export interface EvalReport {
  runAt: string;
  branch: string;
  commit: string;
  totalCases: number;
  passed: number;
  failed: number;
  successRate: number;
  avgSteps: number;
  p95DurationMs: number;
  results: EvalResult[];
}
