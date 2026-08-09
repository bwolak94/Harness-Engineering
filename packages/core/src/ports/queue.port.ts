/**
 * QueuePort — interface for the job queue (Competing Consumers pattern).
 *
 * Implementations:
 *  - InMemoryJobQueue      (tests, single-process dev)
 *  - PostgresJobQueue      (production, FOR UPDATE SKIP LOCKED)
 *
 * Contract:
 *  - enqueue() is idempotent on task.id: re-enqueuing the same task must not
 *    create duplicate rows.
 *  - dequeue() returns at most one job per call; returns null when the queue
 *    is empty or all jobs are locked by other workers.
 *  - ack() removes the job permanently (happy path).
 *  - nack() returns the job to the queue with an optional delay and increments
 *    the attempt counter (failure / bulkhead rejection path).
 */

import type { TaskPacket } from "@harness/contracts";

export interface QueueJob {
  /** Stable queue row identifier. */
  id: string;
  /** Tenant that owns this workflow. */
  tenantId: string;
  /** Full task to execute (goal, budget, etc.). */
  task: TaskPacket;
  /** Higher = processed first (0 = default). */
  priority: number;
  /** Number of previous dequeue attempts. Used for backoff calculation. */
  attempts: number;
}

export interface QueuePort {
  /**
   * Add a task to the queue.
   * Idempotent: if task.id is already in the queue, this is a no-op.
   */
  enqueue(tenantId: string, task: TaskPacket, priority?: number): Promise<void>;

  /**
   * Claim the next available job for this worker.
   * Returns null when the queue is empty or all ready jobs are already locked.
   * The returned job is marked as locked; other workers will skip it.
   */
  dequeue(workerId: string): Promise<QueueJob | null>;

  /**
   * Mark a job as successfully completed and remove it from the queue.
   */
  ack(jobId: string): Promise<void>;

  /**
   * Return a job to the queue after a failure.
   * @param jobId    The job to return.
   * @param delayMs  How long to wait before making the job eligible again.
   *                 0 means immediately re-eligible.
   */
  nack(jobId: string, delayMs: number): Promise<void>;
}

export class NoopQueuePort implements QueuePort {
  async enqueue(): Promise<void> {}
  async dequeue(): Promise<null> {
    return null;
  }
  async ack(): Promise<void> {}
  async nack(): Promise<void> {}
}
