/**
 * OutboxPort — Transactional Outbox pattern for irreversible external effects.
 *
 * Problem: we cannot atomically write to a database AND send an HTTP request.
 * If we send first and the process dies before recording success, we don't know
 * if the request was delivered. If we record first and the process dies before
 * sending, the effect is lost.
 *
 * Solution: record the intent (OutboxItem) in the same durable store as the
 * event, then let a separate worker deliver it with at-least-once semantics.
 * Deduplication on the receiver side (using idempotencyKey) converts
 * at-least-once into effectively-once.
 *
 * Pattern: Transactional Outbox
 *   Standard response to the dual-write problem — no distributed transactions
 *   required; only a local store + a retry loop.
 */

export type OutboxStatus = "pending" | "delivered" | "failed";

export interface OutboxItem {
  /** Globally unique identifier for this outbox entry. */
  id: string;
  /** Logical action type, used by the outbox worker to route to the correct handler. */
  action: string;
  /** JSON-serialisable payload to deliver. */
  payload: Record<string, unknown>;
  /**
   * Caller-supplied deduplication key. The receiver must use this to reject
   * duplicate deliveries (e.g. the shop API checks if this key was already processed).
   */
  idempotencyKey: string;
  /** ISO 8601 timestamp when this item was enqueued. */
  enqueuedAt: string;
  status: OutboxStatus;
  /** Number of delivery attempts made so far. */
  attempts: number;
  /** ISO 8601 timestamp of the last delivery attempt, or null if never attempted. */
  lastAttemptAt: string | null;
}

export interface OutboxPort {
  /**
   * Enqueue a new outbox item for delivery.
   * Must be durable: survives process restarts.
   * If an item with the same idempotencyKey already exists, this call is a no-op.
   */
  enqueue(item: OutboxItem): Promise<void>;

  /**
   * Return all items that have not yet been successfully delivered.
   * The outbox worker calls this on startup and periodically to flush pending items.
   */
  pending(): Promise<readonly OutboxItem[]>;

  /**
   * Mark an item as successfully delivered. Subsequent pending() calls
   * will not include this item.
   */
  markDelivered(id: string): Promise<void>;

  /**
   * Record a failed delivery attempt. Increments attempts and sets lastAttemptAt.
   * The item remains in the pending list for retry.
   */
  recordFailure(id: string): Promise<void>;
}
