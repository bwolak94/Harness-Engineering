import type { ApprovalRequest, ApprovalResponse } from "@harness/contracts/handoff";
import type { ApprovalStorePort } from "@harness/core/ports";

/**
 * InMemoryApprovalStore — in-memory implementation of ApprovalStorePort.
 *
 * Stores approval requests in a plain Map. Suitable for tests and dev.
 * Does NOT persist across process restarts — use the Postgres adapter in production.
 */
export class InMemoryApprovalStore implements ApprovalStorePort {
  private readonly requests = new Map<string, ApprovalRequest>();

  async save(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.requestId, { ...request });
  }

  async get(requestId: string): Promise<ApprovalRequest | undefined> {
    const r = this.requests.get(requestId);
    return r ? { ...r } : undefined;
  }

  async getByWorkflow(workflowId: string): Promise<ApprovalRequest[]> {
    const result: ApprovalRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.workflowId === workflowId) {
        result.push({ ...request });
      }
    }
    return result;
  }

  async decide(requestId: string, response: ApprovalResponse): Promise<void> {
    const existing = this.requests.get(requestId);
    if (!existing) return; // idempotent: unknown requestId is a no-op
    if (existing.status !== "pending") return; // already decided

    this.requests.set(requestId, {
      ...existing,
      status: response.decision,
    });
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Returns the total number of stored requests. */
  get size(): number {
    return this.requests.size;
  }

  /** Removes all stored requests. */
  clear(): void {
    this.requests.clear();
  }
}
