// ---------------------------------------------------------------------------
// CanaryStorePort — persists shadow run metrics for canary analysis
// ---------------------------------------------------------------------------

/** Resource usage snapshot for one flow execution (baseline or canary). */
export interface CanaryRunMetrics {
  /** Number of agent steps that completed (regardless of success/failure). */
  stepCount: number;
  /** Total tokens consumed by all agents in this execution. */
  tokensUsed: number;
  /** Estimated cost in USD across all agents. */
  costUsd: number;
  /** Wall-clock duration in milliseconds from run start to final result. */
  durationMs: number;
  /** True when at least one step failed (partial success). */
  partial: boolean;
}

/** One paired baseline + shadow run stored for divergence analysis. */
export interface CanaryRunRecord {
  /** Unique record identifier. */
  id: string;
  /** Flow id of the production baseline. */
  baselineFlowId: string;
  /** Flow id of the canary variant that ran in shadow. */
  canaryFlowId: string;
  /** Version string from the canary FlowSpec (if set). */
  canaryVersion: string;
  /** The user goal string that was executed. */
  goal: string;
  /** ISO-8601 timestamp of when this record was created. */
  at: string;
  /** Metrics from the production (baseline) run. */
  baseline: CanaryRunMetrics;
  /** Metrics from the shadow (canary) run. */
  canary: CanaryRunMetrics;
}

export interface CanaryStorePort {
  /** Persist a paired run record. */
  save(record: CanaryRunRecord): Promise<void>;

  /**
   * Retrieve the most recent `limit` records for a given baseline flow.
   * Results are ordered newest-first.
   */
  list(baselineFlowId: string, limit?: number): Promise<readonly CanaryRunRecord[]>;
}

// ---------------------------------------------------------------------------
// NoopCanaryStore — discards all data; for use when canary is disabled
// ---------------------------------------------------------------------------

export class NoopCanaryStore implements CanaryStorePort {
  async save(_record: CanaryRunRecord): Promise<void> {
    // intentionally empty
  }

  async list(_baselineFlowId: string, _limit?: number): Promise<readonly CanaryRunRecord[]> {
    return [];
  }
}
