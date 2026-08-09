/**
 * WorkerLoop — Competing Consumers + Lease + Heartbeat
 *
 * Lifecycle per iteration:
 *  1. Dequeue one job (skips locked rows, respects bulkhead).
 *  2. Acquire step lease (prevents concurrent execution of the same workflow).
 *  3. Start heartbeat interval (extends lease every leaseDurationMs/2).
 *  4. Execute: resume() if the workflow has prior events; run() otherwise.
 *  5. On success: ack + release lease.
 *  6. On failure: nack with exponential backoff; give up after maxAttempts.
 *  7. SIGTERM path: abort signal set → finish current job → exit run().
 *
 * Pattern: Competing Consumers (queue), Lease + Heartbeat (crash detection)
 */

import type { EventLogPort, HarnessRuntime, LeasePort, QueuePort } from "@harness/core";

// ---------------------------------------------------------------------------
// Backoff helper
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000;

/**
 * Exponential backoff with ±25% jitter.
 * attempts=0 → 0 ms (immediate retry)
 * attempts=1 → ~1s, attempts=2 → ~4s, attempts=3 → ~9s …
 */
function backoffMs(attempts: number): number {
  if (attempts === 0) return 0;
  const base = Math.min(attempts * attempts * 1_000, MAX_BACKOFF_MS);
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
  return Math.max(0, Math.round(base + jitter));
}

// ---------------------------------------------------------------------------
// WorkerLoop
// ---------------------------------------------------------------------------

export interface WorkerLoopOptions {
  workerId: string;
  /** How long to wait between empty-queue polls. */
  pollIntervalMs: number;
  /** Duration of each lease; heartbeats renew it every leaseDurationMs/2. */
  leaseDurationMs: number;
  /** Give up executing a workflow after this many attempts. */
  maxAttempts: number;
}

export class WorkerLoop {
  constructor(
    private readonly queue: QueuePort,
    private readonly lease: LeasePort,
    private readonly runtime: HarnessRuntime,
    private readonly eventLog: EventLogPort,
    private readonly opts: WorkerLoopOptions,
  ) {}

  /**
   * Run the worker loop until `signal` is aborted (SIGTERM).
   * Returns after the current job finishes — never kills mid-execution.
   */
  async run(signal: AbortSignal): Promise<void> {
    // Reap any expired leases left over from previous workers on each startup.
    await this.lease.reapExpired().catch((err: unknown) => {
      console.error("[worker] reapExpired failed:", err);
    });

    while (!signal.aborted) {
      await this.processOne(signal);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async processOne(signal: AbortSignal): Promise<void> {
    const job = await this.queue.dequeue(this.opts.workerId);

    if (!job) {
      // Queue is empty or all ready jobs are at tenant concurrency limit.
      await sleep(this.opts.pollIntervalMs, signal);
      return;
    }

    // The workflow ID is the task ID stored in the job payload.
    const workflowId = job.task.id;
    const { tenantId } = job;

    // Acquire a step lease to prevent another worker from claiming the same workflow.
    const leaseAcquired = await this.lease.acquire(
      workflowId,
      tenantId,
      this.opts.workerId,
      this.opts.leaseDurationMs,
    );

    if (!leaseAcquired) {
      // Another worker holds the lease; return the job to the queue immediately.
      await this.queue.nack(job.id, 0);
      return;
    }

    // Start heartbeat while executing.
    const heartbeatInterval = this.opts.leaseDurationMs / 2;
    const heartbeatTimer = setInterval(() => {
      void this.lease
        .heartbeat(workflowId, this.opts.workerId, this.opts.leaseDurationMs)
        .catch((err: unknown) => {
          console.error(`[worker] heartbeat failed for ${workflowId}:`, err);
        });
    }, heartbeatInterval);

    try {
      await this.execute(job);
      await this.queue.ack(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[worker] execution failed for workflow ${workflowId} (attempt ${job.attempts + 1}):`,
        message,
      );

      if (job.attempts + 1 >= this.opts.maxAttempts) {
        // Give up — ack to remove from queue (workflow is already in failed state).
        console.error(`[worker] giving up on ${workflowId} after ${this.opts.maxAttempts} attempts`);
        await this.queue.ack(job.id);
      } else {
        const delay = backoffMs(job.attempts);
        await this.queue.nack(job.id, delay);
      }
    } finally {
      clearInterval(heartbeatTimer);
      await this.lease.release(workflowId, this.opts.workerId).catch((releaseErr: unknown) => {
        console.error(`[worker] lease release failed for ${workflowId}:`, releaseErr);
      });
    }
  }

  /**
   * Decide whether to run (first time) or resume (restarted after crash).
   * A workflow that has a `workflow.started` event already was interrupted;
   * all others are brand new.
   */
  private async execute(job: import("@harness/core").QueueJob): Promise<void> {
    const workflowId = job.task.id;
    const existingEvents = await this.eventLog.read(workflowId, 0);
    const hasStarted = existingEvents.some((e) => e.type === "workflow.started");

    if (hasStarted) {
      await this.runtime.resume(workflowId);
    } else {
      // Use the task stored in the job — it carries the full TaskPacket (goal, budget).
      await this.runtime.run(job.task);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
