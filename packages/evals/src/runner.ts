import {
  FixedClock,
  InMemoryApprovalStore,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryToolRegistry,
  SeededIdPort,
} from "@harness/adapters-memory";
import { HarnessRuntime } from "@harness/core";
import { createDefaultToolExecutors } from "@harness/core/tools";
import { runOutcomeCheck, runTrajectoryCheck } from "./judge.js";
import { diffSnapshots, loadSnapshot, saveSnapshot, toEventTypeSequence } from "./snapshot.js";
import type { EvalCase, EvalResult } from "./types.js";

export interface RunOptions {
  /**
   * When true, snapshot files are regenerated from the current run output
   * rather than compared against existing ones.
   * Use this when intentionally changing the event sequence.
   */
  updateSnapshots?: boolean;
}

/**
 * EvalRunner — executes a single EvalCase and returns a structured result.
 *
 * Isolation: each run gets its own in-memory adapters so cases cannot
 * interfere with each other even when run in sequence.
 *
 * The runner resets the FakeModelPort before each run so the same EvalCase
 * can be run multiple times (e.g. in both snapshot-update and regression mode).
 */
export class EvalRunner {
  async run(evalCase: EvalCase, opts: RunOptions = {}): Promise<EvalResult> {
    const startMs = Date.now();

    // Fresh adapters per run — no shared state.
    const eventLog = new InMemoryEventLog();
    const stateStore = new InMemoryStateStore();
    const toolRegistry = new InMemoryToolRegistry();
    for (const executor of createDefaultToolExecutors()) {
      toolRegistry.register(executor);
    }
    const clock = new FixedClock(Date.now());
    const idPort = new SeededIdPort();
    const approvalStore = new InMemoryApprovalStore();

    // Reset the scripted model so repeated runs of the same case start fresh.
    evalCase.model.reset();

    const runtime = new HarnessRuntime({
      model: evalCase.model,
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort,
      middleware: [],
      approvalStore,
    });

    const state = await runtime.run(evalCase.task);
    const durationMs = Date.now() - startMs;
    const events = await eventLog.read(evalCase.task.id);

    // --- Outcome checks ---
    // Outcome checks run against the last successful tool result.
    // withResultTruncation (applied by createDefaultToolExecutors) serialises
    // the result to a JSON string before storing it in the event log.
    // We parse it back to an object here so path navigation works correctly.
    const lastSucceeded = [...events].reverse().find((e) => e.type === "tool.succeeded");
    const rawResult = lastSucceeded
      ? (lastSucceeded.payload as { result?: unknown }).result
      : undefined;
    let toolResult: unknown;
    if (typeof rawResult === "string") {
      try {
        toolResult = JSON.parse(rawResult);
      } catch {
        toolResult = rawResult;
      }
    } else {
      toolResult = rawResult;
    }

    const outcomeFailures = evalCase.outcomeChecks
      .map((check) =>
        toolResult !== undefined
          ? runOutcomeCheck(toolResult, check)
          : {
              check,
              message: "No tool.succeeded event found — cannot run outcome check",
            },
      )
      .filter((f): f is NonNullable<typeof f> => f !== null);

    // --- Trajectory checks ---
    const trajectoryFailures = evalCase.trajectoryChecks
      .map((constraint) => runTrajectoryCheck(events, state, constraint))
      .filter((f): f is NonNullable<typeof f> => f !== null);

    // --- Snapshot checks ---
    let snapshotDiff: string | null = null;
    if (evalCase.snapshot) {
      const actual = toEventTypeSequence(events);
      if (opts.updateSnapshots) {
        saveSnapshot(evalCase.id, actual);
      } else {
        const expected = loadSnapshot(evalCase.id);
        if (expected !== null) {
          snapshotDiff = diffSnapshots(expected, actual);
        } else {
          // First run — save the snapshot automatically.
          saveSnapshot(evalCase.id, actual);
        }
      }
    }

    const passed =
      outcomeFailures.length === 0 && trajectoryFailures.length === 0 && snapshotDiff === null;

    return {
      caseId: evalCase.id,
      tool: evalCase.tool,
      description: evalCase.description,
      passed,
      outcomeFailures,
      trajectoryFailures,
      snapshotDiff,
      steps: events.filter((e) => e.type === "tool.called").length,
      durationMs,
      status: state.status,
      events: [...events],
    };
  }

  /** Run multiple cases in sequence and collect all results. */
  async runAll(cases: EvalCase[], opts: RunOptions = {}): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    for (const evalCase of cases) {
      results.push(await this.run(evalCase, opts));
    }
    return results;
  }
}
