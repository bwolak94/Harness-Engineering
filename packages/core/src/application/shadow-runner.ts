import type { HarnessEvent } from "@harness/contracts";
import type { CanaryRunMetrics, CanaryStorePort } from "../ports/canary-store.port.js";
import type { CanaryThresholds } from "./canary-analyzer.js";
import { DEFAULT_CANARY_THRESHOLDS, analyzeCanaryRun } from "./canary-analyzer.js";
import type { FlowRunResult, FlowSpec } from "./flow-runner.js";
import { FlowRunner, type FlowRunnerDeps } from "./flow-runner.js";

// ---------------------------------------------------------------------------
// ShadowRunnerConfig
// ---------------------------------------------------------------------------

export interface ShadowRunnerConfig {
  /**
   * The canary flow variant to run in shadow mode.
   * Must carry a `canary` config block with at least `trafficPct`.
   */
  canarySpec: FlowSpec;
  /**
   * Override for divergence thresholds. Falls back to canarySpec.canary config,
   * then to DEFAULT_CANARY_THRESHOLDS.
   */
  thresholds?: Partial<CanaryThresholds>;
  /** Store where paired run records are persisted. */
  canaryStore: CanaryStorePort;
  /**
   * Optional callback invoked with canary lifecycle events
   * (canary.started, canary.completed, canary.regression).
   * Wire to EventBus / live publish at the composition root.
   */
  onEvent?: (event: HarnessEvent) => void;
}

// ---------------------------------------------------------------------------
// ShadowRunner
// ---------------------------------------------------------------------------

/**
 * ShadowRunner — wraps FlowRunner to add shadow-mode canary execution.
 *
 * On each `run()` call the ShadowRunner:
 *  1. Executes the **baseline** flow normally and returns its result immediately.
 *  2. Based on `trafficPct`, fires a background shadow execution of the canary
 *     flow (fire-and-forget — never blocks the caller).
 *  3. When the shadow finishes, persists a `CanaryRunRecord` and emits
 *     `canary.completed` (+ `canary.regression` if thresholds are breached).
 *
 * The production path is completely unchanged — the caller receives the
 * baseline result with no added latency.
 */
export class ShadowRunner {
  private readonly baselineRunner: FlowRunner;
  private readonly canaryRunner: FlowRunner;

  constructor(
    private readonly deps: FlowRunnerDeps,
    private readonly config: ShadowRunnerConfig,
  ) {
    this.baselineRunner = new FlowRunner(deps);
    // Canary runner uses a separate id space so its workflow IDs don't collide.
    this.canaryRunner = new FlowRunner(deps);
  }

  /**
   * Run the baseline flow and return its result.
   * Conditionally fires a shadow canary run in the background.
   */
  async run(
    baselineSpec: FlowSpec,
    userGoal: string,
    budget: Parameters<FlowRunner["run"]>[2],
    signal?: AbortSignal,
  ): Promise<FlowRunResult> {
    const startMs = this.deps.clock.now();

    const baselineResult = await this.baselineRunner.run(baselineSpec, userGoal, budget, signal);

    const baselineDurationMs = this.deps.clock.now() - startMs;

    // Decide whether to fire the shadow run
    const trafficPct = this.config.canarySpec.canary?.trafficPct ?? 0;
    const shouldShadow = Math.random() * 100 < trafficPct;

    if (shouldShadow && !signal?.aborted) {
      // Fire-and-forget: shadow runs in the background, never blocking the caller.
      void this.runShadow(baselineSpec, baselineResult, baselineDurationMs, userGoal, budget).catch(
        () => {
          // Shadow failures are silently swallowed — they must never surface to the user.
        },
      );
    }

    return baselineResult;
  }

  // ---------------------------------------------------------------------------
  // Private — shadow execution
  // ---------------------------------------------------------------------------

  private async runShadow(
    baselineSpec: FlowSpec,
    baselineResult: FlowRunResult,
    baselineDurationMs: number,
    userGoal: string,
    budget: Parameters<FlowRunner["run"]>[2],
  ): Promise<void> {
    const { canarySpec, canaryStore, onEvent } = this.config;

    // Resolve effective thresholds: explicit > canarySpec.canary > defaults
    const canaryDefaults = {
      maxCostDeltaPct:
        canarySpec.canary?.maxCostDeltaPct ?? DEFAULT_CANARY_THRESHOLDS.maxCostDeltaPct,
      maxTokenDeltaPct:
        canarySpec.canary?.maxTokenDeltaPct ?? DEFAULT_CANARY_THRESHOLDS.maxTokenDeltaPct,
      maxDurationDeltaPct:
        canarySpec.canary?.maxDurationDeltaPct ?? DEFAULT_CANARY_THRESHOLDS.maxDurationDeltaPct,
    };
    const thresholds: CanaryThresholds = {
      ...canaryDefaults,
      ...this.config.thresholds,
    };

    const shadowWorkflowId = this.deps.idPort.newId();
    const now = this.deps.clock.now();
    const at = new Date(now).toISOString();

    // Emit canary.started
    if (onEvent !== undefined) {
      onEvent(
        this.buildEvent("canary.started", shadowWorkflowId, at, {
          baselineFlowId: baselineSpec.id,
          canaryFlowId: canarySpec.id,
          canaryVersion: canarySpec.version ?? "unversioned",
          shadowWorkflowId,
          trafficPct: canarySpec.canary?.trafficPct ?? 0,
        }),
      );
    }

    const shadowStartMs = this.deps.clock.now();
    let canaryResult: FlowRunResult;
    try {
      canaryResult = await this.canaryRunner.run(canarySpec, userGoal, budget);
    } catch {
      // If shadow execution throws entirely, bail silently.
      return;
    }
    const canaryDurationMs = this.deps.clock.now() - shadowStartMs;

    // Build metrics from run results
    const baselineMetrics = metricsFromResult(baselineResult, baselineDurationMs);
    const canaryMetrics = metricsFromResult(canaryResult, canaryDurationMs);

    // Analyze divergence
    const analysis = analyzeCanaryRun(baselineMetrics, canaryMetrics, thresholds);

    // Persist the paired record
    const record = {
      id: shadowWorkflowId,
      baselineFlowId: baselineSpec.id,
      canaryFlowId: canarySpec.id,
      canaryVersion: canarySpec.version ?? "unversioned",
      goal: userGoal,
      at,
      baseline: baselineMetrics,
      canary: canaryMetrics,
    };
    await canaryStore.save(record);

    if (onEvent !== undefined) {
      // Emit canary.completed
      onEvent(
        this.buildEvent("canary.completed", shadowWorkflowId, at, {
          baselineFlowId: baselineSpec.id,
          canaryFlowId: canarySpec.id,
          shadowWorkflowId,
          regression: analysis.regression,
          divergence: {
            stepCountDelta: analysis.divergence.stepCountDelta,
            tokenDeltaPct: analysis.divergence.tokenDeltaPct,
            costDeltaPct: analysis.divergence.costDeltaPct,
            durationDeltaPct: analysis.divergence.durationDeltaPct,
          },
        }),
      );

      // Emit canary.regression if thresholds breached
      if (analysis.regression && analysis.regressionReason !== undefined) {
        onEvent(
          this.buildEvent("canary.regression", shadowWorkflowId, at, {
            baselineFlowId: baselineSpec.id,
            canaryFlowId: canarySpec.id,
            shadowWorkflowId,
            reason: analysis.regressionReason,
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event builder helper (avoids importing zod-parsed IDs — purely structural)
  // ---------------------------------------------------------------------------

  private buildEvent(
    type: string,
    workflowId: string,
    at: string,
    payload: Record<string, unknown>,
  ): HarnessEvent {
    return {
      type,
      id: this.deps.idPort.newId(),
      workflowId,
      seq: 0,
      at,
      payload,
    } as unknown as HarnessEvent;
  }
}

// ---------------------------------------------------------------------------
// metricsFromResult — derive CanaryRunMetrics from a FlowRunResult
//
// FlowRunResult does not carry token/cost data directly — those are tracked
// inside each agent's WorkflowState, which is not returned by FlowRunner.run().
// We approximate from what IS available: step count, partial flag, duration.
// Token/cost are set to 0 here; production deployments should wire a
// MetricsCollector that aggregates from the EventLog instead.
// ---------------------------------------------------------------------------

function metricsFromResult(result: FlowRunResult, durationMs: number): CanaryRunMetrics {
  return {
    stepCount: result.steps.length,
    tokensUsed: 0,
    costUsd: 0,
    durationMs,
    partial: result.partial,
  };
}
