import type { ApprovalRequest, ApprovalResponse } from "@harness/contracts/handoff";

// ---------------------------------------------------------------------------
// ApprovalStorePort — durable storage for human-in-the-loop approval requests
//
// An ApprovalRequest is created when the runtime suspends a workflow waiting
// for human confirmation. The record holds the full decision context:
// what tool was requested, why, what the deadline is, and — once decided —
// who approved/rejected and when.
//
// Pattern: Repository — isolated behind this interface so adapters (Postgres,
// in-memory, mock) can be swapped without touching the runtime.
// ---------------------------------------------------------------------------

export interface ApprovalStorePort {
  /** Persist a new pending approval request. */
  save(request: ApprovalRequest): Promise<void>;

  /** Look up a request by its requestId. Returns undefined if not found. */
  get(requestId: string): Promise<ApprovalRequest | undefined>;

  /**
   * Return all requests for a given workflow, ordered by creation time.
   * Most callers want the PENDING one; filtering by status is the caller's job.
   */
  getByWorkflow(workflowId: string): Promise<ApprovalRequest[]>;

  /**
   * Record a human decision.
   * Updates the status and attaches decidedBy, decidedAt, and optional comment/reason
   * from the ApprovalResponse. Idempotent: deciding an already-decided request is a no-op.
   */
  decide(requestId: string, response: ApprovalResponse): Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopApprovalStore — throws on every call (surfaces missing wiring at runtime)
// ---------------------------------------------------------------------------

export class NoopApprovalStore implements ApprovalStorePort {
  async save(_request: ApprovalRequest): Promise<void> {
    throw new Error(
      "NoopApprovalStore.save() called — wire a real ApprovalStorePort in the composition root.",
    );
  }

  async get(_requestId: string): Promise<ApprovalRequest | undefined> {
    return undefined;
  }

  async getByWorkflow(_workflowId: string): Promise<ApprovalRequest[]> {
    return [];
  }

  async decide(_requestId: string, _response: ApprovalResponse): Promise<void> {
    throw new Error(
      "NoopApprovalStore.decide() called — wire a real ApprovalStorePort in the composition root.",
    );
  }
}
