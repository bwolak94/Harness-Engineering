/**
 * UsageLedgerPort — append-only record of resource consumption per workflow.
 *
 * Pattern: Ledger (append-only fact table)
 *
 * Each completed workflow writes one or more entries:
 *  - kind="run"        qty=1       cost_usd=total workflow cost
 *  - kind="step"       qty=N       cost_usd=0 (steps are free events)
 *  - kind="tokens_in"  qty=N       cost_usd=0
 *  - kind="tokens_out" qty=N       cost_usd=0
 *  - kind="tool_error" qty=N       cost_usd=0
 *
 * The ledger feeds into usage_rollups_daily (CQRS read model) via UsageRollupJob.
 * Billing (T19) reads from rollups, not from the raw ledger.
 *
 * Security: entries are tenant-scoped. The Postgres adapter uses the RLS-bypassing
 * pool (direct pool query) because recording happens in the worker process which
 * must write on behalf of the tenant without an active JWT session.
 */

export interface UsageLedgerEntry {
  /** Row identifier — idempotency key (workflowId + kind is unique enough). */
  id: string;
  tenantId: string;
  workflowId: string;
  /** Event timestamp — used for partition routing and rollup boundaries. */
  ts: Date;
  /** Consumption kind: 'run' | 'step' | 'tokens_in' | 'tokens_out' | 'tool_error' */
  kind: string;
  /** Quantity of the resource consumed. */
  qty: bigint;
  /** Estimated USD cost attributed to this entry (0 for non-cost entries). */
  costUsd: number;
}

export interface UsageLedgerPort {
  /** Append one or more entries to the ledger. Idempotent on entry.id. */
  append(entries: UsageLedgerEntry[]): Promise<void>;
}

export class NoopUsageLedger implements UsageLedgerPort {
  async append(_entries: UsageLedgerEntry[]): Promise<void> {}
}
