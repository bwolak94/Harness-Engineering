/**
 * InMemoryJobQueue — in-process QueuePort for tests and local dev.
 *
 * Not thread-safe; single-process only. All timestamps are wall-clock.
 * Useful for testing the WorkerLoop without a real database.
 */

import { randomUUID } from "node:crypto";
import type { TaskPacket } from "@harness/contracts";
import type { QueueJob, QueuePort } from "@harness/core";

interface StoredJob extends QueueJob {
  runAfter: number; // epoch ms
  lockedBy: string | null;
  lockedUntil: number | null;
}

export class InMemoryJobQueue implements QueuePort {
  private readonly jobs = new Map<string, StoredJob>();

  async enqueue(tenantId: string, task: TaskPacket, priority = 0): Promise<void> {
    // Idempotent: skip if this workflow is already queued.
    for (const job of this.jobs.values()) {
      if (job.task.id === task.id) return;
    }
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      tenantId,
      task,
      priority,
      attempts: 0,
      runAfter: Date.now(),
      lockedBy: null,
      lockedUntil: null,
    });
  }

  async dequeue(workerId: string): Promise<QueueJob | null> {
    const now = Date.now();
    // Find the highest-priority, earliest-available unlocked job.
    let best: StoredJob | null = null;
    for (const job of this.jobs.values()) {
      if (job.lockedBy !== null && (job.lockedUntil ?? 0) > now) continue;
      if (job.runAfter > now) continue;
      if (!best || job.priority > best.priority || job.runAfter < best.runAfter) {
        best = job;
      }
    }
    if (!best) return null;

    // Claim the job (5-minute default lock horizon in memory).
    best.lockedBy = workerId;
    best.lockedUntil = now + 5 * 60_000;
    return {
      id: best.id,
      tenantId: best.tenantId,
      task: best.task,
      priority: best.priority,
      attempts: best.attempts,
    };
  }

  async ack(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }

  async nack(jobId: string, delayMs: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.lockedBy = null;
    job.lockedUntil = null;
    job.attempts += 1;
    job.runAfter = Date.now() + delayMs;
  }

  /** Test helper — returns total number of jobs (any state). */
  size(): number {
    return this.jobs.size;
  }

  /** Test helper — returns all jobs for assertions. */
  all(): StoredJob[] {
    return [...this.jobs.values()];
  }

  /** Test helper — clears all jobs. */
  clear(): void {
    this.jobs.clear();
  }
}
