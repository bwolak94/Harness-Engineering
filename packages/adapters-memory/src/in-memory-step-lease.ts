/**
 * InMemoryStepLease — in-process LeasePort for tests and local dev.
 *
 * Not thread-safe; single-process only.
 */

import type { LeasePort } from "@harness/core";

interface StoredLease {
  workflowId: string;
  tenantId: string;
  workerId: string;
  leaseUntil: number; // epoch ms
  heartbeatAt: number; // epoch ms
}

export class InMemoryStepLease implements LeasePort {
  private readonly leases = new Map<string, StoredLease>();

  async acquire(
    workflowId: string,
    tenantId: string,
    workerId: string,
    durationMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const existing = this.leases.get(workflowId);
    if (existing && existing.leaseUntil > now) {
      // Held by someone; allow re-acquisition only if it's the same worker.
      return existing.workerId === workerId;
    }
    this.leases.set(workflowId, {
      workflowId,
      tenantId,
      workerId,
      leaseUntil: now + durationMs,
      heartbeatAt: now,
    });
    return true;
  }

  async heartbeat(workflowId: string, workerId: string, durationMs: number): Promise<boolean> {
    const now = Date.now();
    const lease = this.leases.get(workflowId);
    if (!lease || lease.workerId !== workerId || lease.leaseUntil <= now) {
      return false;
    }
    lease.leaseUntil = now + durationMs;
    lease.heartbeatAt = now;
    return true;
  }

  async release(workflowId: string, workerId: string): Promise<void> {
    const lease = this.leases.get(workflowId);
    if (lease?.workerId === workerId) {
      this.leases.delete(workflowId);
    }
  }

  async reapExpired(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [key, lease] of this.leases) {
      if (lease.leaseUntil <= now) {
        this.leases.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** Test helper — current number of active leases. */
  size(): number {
    return this.leases.size;
  }

  /** Test helper — check if a lease exists and is valid. */
  has(workflowId: string): boolean {
    const lease = this.leases.get(workflowId);
    return lease !== undefined && lease.leaseUntil > Date.now();
  }
}
