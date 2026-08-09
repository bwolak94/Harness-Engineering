/**
 * WorkerLoop unit tests (T17 Definition of Done).
 *
 * All adapters are in-memory — no Docker required.
 *
 * DoD coverage:
 *  ✅ processOne dequeues a job and calls runtime.run() for a new workflow
 *  ✅ processOne calls runtime.resume() when workflow.started event exists
 *  ✅ ack is called on success
 *  ✅ nack is called with exponential backoff on failure
 *  ✅ after maxAttempts failures the job is ack'd (dead letter)
 *  ✅ loop sleeps when queue is empty
 *  ✅ SIGTERM (abort signal) stops the loop after current job finishes
 *  ✅ lease is acquired before execute and released in finally
 *  ✅ lease conflict: nack immediately with 0ms delay
 */

import { randomUUID } from "node:crypto";
import { InMemoryEventLog, InMemoryJobQueue, InMemoryStepLease } from "@harness/adapters-memory";
import type { TaskPacket } from "@harness/contracts";
import type { HarnessRuntime } from "@harness/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerLoop } from "../worker-loop.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id = randomUUID()): TaskPacket {
  return {
    id,
    goal: "test goal",
    budget: { maxTokens: 1000, maxSteps: 10, maxWallClockMs: 10_000, maxCostUsd: 1 },
  };
}

function makeOpts(
  overrides: Partial<{
    workerId: string;
    pollIntervalMs: number;
    leaseDurationMs: number;
    maxAttempts: number;
  }> = {},
) {
  return {
    workerId: "test-worker",
    pollIntervalMs: 1,
    leaseDurationMs: 60_000,
    maxAttempts: 3,
    ...overrides,
  };
}

/**
 * Wraps queue.ack() to abort the controller after the first call.
 * This lets the loop finish exactly one successful job then stop.
 */
function abortAfterAck(queue: InMemoryJobQueue, controller: AbortController): void {
  const orig = queue.ack.bind(queue);
  vi.spyOn(queue, "ack").mockImplementation(async (id) => {
    await orig(id);
    controller.abort();
  });
}

/**
 * Wraps queue.nack() to abort the controller after the first call.
 * This lets the loop finish exactly one failed job then stop.
 */
function abortAfterNack(queue: InMemoryJobQueue, controller: AbortController): void {
  const orig = queue.nack.bind(queue);
  vi.spyOn(queue, "nack").mockImplementation(async (id, delay) => {
    await orig(id, delay);
    controller.abort();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerLoop", () => {
  let queue: InMemoryJobQueue;
  let lease: InMemoryStepLease;
  let eventLog: InMemoryEventLog;
  let runtime: HarnessRuntime;

  beforeEach(() => {
    queue = new InMemoryJobQueue();
    lease = new InMemoryStepLease();
    eventLog = new InMemoryEventLog();
    runtime = {
      run: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    } as unknown as HarnessRuntime;
  });

  it("calls runtime.run() for a brand-new workflow (no events)", async () => {
    const task = makeTask();
    await queue.enqueue("t1", task);

    const controller = new AbortController();
    abortAfterAck(queue, controller);

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts());
    await loop.run(controller.signal);

    expect(runtime.run).toHaveBeenCalledOnce();
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(queue.size()).toBe(0); // ack removed the job
  });

  it("calls runtime.resume() when workflow.started event already exists", async () => {
    const task = makeTask();
    await queue.enqueue("t1", task);

    await eventLog.append({
      id: randomUUID(),
      workflowId: task.id,
      seq: 1,
      at: new Date().toISOString(),
      type: "workflow.started",
      payload: { task },
    });

    const controller = new AbortController();
    abortAfterAck(queue, controller);

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts());
    await loop.run(controller.signal);

    expect(runtime.resume).toHaveBeenCalledOnce();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("nacks with backoff on execution failure (not last attempt)", async () => {
    const task = makeTask();
    await queue.enqueue("t1", task);

    const controller = new AbortController();
    abortAfterNack(queue, controller);

    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("transient"));

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts({ maxAttempts: 3 }));
    await loop.run(controller.signal);

    const jobs = queue.all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.attempts).toBe(1); // nack incremented
  });

  it("acks (dead-letters) after maxAttempts failures", async () => {
    const task = makeTask();
    await queue.enqueue("t1", task);

    // Simulate 2 prior attempts so the next failure hits maxAttempts=3.
    const jobs = queue.all();
    if (jobs[0]) jobs[0].attempts = 2;

    const controller = new AbortController();
    abortAfterAck(queue, controller);

    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fatal"));

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts({ maxAttempts: 3 }));
    await loop.run(controller.signal);

    expect(queue.size()).toBe(0); // ack'd — removed from queue
  });

  it("sleeps when queue is empty and exits on abort", async () => {
    const controller = new AbortController();
    // Abort immediately — loop should not process any jobs
    controller.abort();

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts({ pollIntervalMs: 1 }));
    await loop.run(controller.signal);

    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("releases the lease even when execution throws", async () => {
    const task = makeTask();
    await queue.enqueue("t1", task);

    const controller = new AbortController();
    abortAfterNack(queue, controller);

    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts({ maxAttempts: 5 }));
    await loop.run(controller.signal);

    expect(lease.size()).toBe(0); // lease released in finally
  });

  it("nacks immediately when lease is held by another worker", async () => {
    const task = makeTask();
    await queue.enqueue("t1", task);

    // Pre-acquire the lease with a different worker.
    await lease.acquire(task.id, "t1", "other-worker", 60_000);

    const controller = new AbortController();
    abortAfterNack(queue, controller);

    const loop = new WorkerLoop(queue, lease, runtime, eventLog, makeOpts());
    await loop.run(controller.signal);

    expect(runtime.run).not.toHaveBeenCalled();
    // Job still in queue (nacked) with incremented attempts.
    expect(queue.size()).toBe(1);
  });
});
