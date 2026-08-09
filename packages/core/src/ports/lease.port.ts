/**
 * LeasePort — Lease + Heartbeat pattern for worker crash detection.
 *
 * A worker acquires a lease on a workflow before executing it.
 * The worker renews (heartbeats) the lease periodically while running.
 * If the worker crashes, heartbeats stop, the lease expires, and the reaper
 * returns the job to the queue so another worker can resume it (T07).
 *
 * Implementations:
 *  - InMemoryStepLease  (tests, single-process dev)
 *  - PostgresStepLease  (production, step_leases table)
 */

export interface LeasePort {
  /**
   * Acquire an exclusive lease on a workflow.
   *
   * @returns true if the lease was acquired; false if another worker holds it.
   */
  acquire(
    workflowId: string,
    tenantId: string,
    workerId: string,
    durationMs: number,
  ): Promise<boolean>;

  /**
   * Extend an existing lease (heartbeat).
   *
   * @returns true if the lease was successfully renewed; false if expired or
   *          held by a different worker (caller should stop execution).
   */
  heartbeat(workflowId: string, workerId: string, durationMs: number): Promise<boolean>;

  /**
   * Explicitly release a lease on graceful shutdown.
   * No-op if the lease does not exist or belongs to a different worker.
   */
  release(workflowId: string, workerId: string): Promise<void>;

  /**
   * Delete all leases that have passed their `lease_until` timestamp.
   * Called periodically by every worker instance; safe to call concurrently.
   *
   * @returns Number of leases reaped.
   */
  reapExpired(): Promise<number>;
}

export class NoopLeasePort implements LeasePort {
  async acquire(): Promise<true> {
    return true;
  }
  async heartbeat(): Promise<true> {
    return true;
  }
  async release(): Promise<void> {}
  async reapExpired(): Promise<0> {
    return 0;
  }
}
