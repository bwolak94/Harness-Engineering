/**
 * Worker process — composition root.
 *
 * Lifecycle:
 *  1. Parse env; create Postgres pool.
 *  2. Apply schema (idempotent — safe on restart).
 *  3. Wire adapters → WorkerLoop.
 *  4. Register SIGTERM: abort the loop, wait for current job to finish, exit 0.
 */

import { randomUUID } from "node:crypto";
import { InMemoryEventLog, InMemoryToolRegistry } from "@harness/adapters-memory";
import {
  PostgresJobQueue,
  PostgresStepLease,
  applyMultiTenancy,
  applySchema,
} from "@harness/adapters-postgres";
import { parseEnv } from "@harness/contracts/env";
import { HarnessRuntime, WallClock } from "@harness/core";
import { createDefaultToolExecutors } from "@harness/core/tools";
import { Pool } from "pg";
import { WorkerLoop } from "./worker-loop.js";

async function main(): Promise<void> {
  const env = parseEnv();

  // Use a unique worker ID per process so concurrent workers don't share lock identity.
  const workerId = env.WORKER_ID === "worker-1" ? `worker-${randomUUID()}` : env.WORKER_ID;

  console.log(`[worker] starting with id=${workerId}`);

  const pool = new Pool({ connectionString: env.DATABASE_URL });

  // Apply schema on startup — idempotent DDL, safe to run on every boot.
  await applySchema(pool);
  await applyMultiTenancy(pool);

  // Adapters
  const queue = new PostgresJobQueue(pool);
  const lease = new PostgresStepLease(pool);

  // Runtime (in-memory event log + state store — worker is stateless between jobs;
  // actual durable storage is handled by the PostgresEventLog / PostgresStateStore
  // wired in the HarnessRuntime passed to apps that need persistence).
  const eventLog = new InMemoryEventLog();
  const toolRegistry = new InMemoryToolRegistry();
  for (const executor of createDefaultToolExecutors()) {
    toolRegistry.register(executor);
  }

  const runtime = new HarnessRuntime({
    model: {
      // Replaced with real LLM adapter when wired from env (T05 pattern).
      // Worker is a separate process — LLM dep injection follows the same pattern.
      generate: async () => {
        throw new Error("Worker: model port not configured — inject a real ModelPort");
      },
    },
    eventLog,
    stateStore: { load: async () => undefined, save: async () => {} },
    toolRegistry,
    clock: new WallClock(),
    idPort: { newId: () => randomUUID() },
    middleware: [],
  });

  const loop = new WorkerLoop(queue, lease, runtime, eventLog, {
    workerId,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    leaseDurationMs: env.WORKER_LEASE_DURATION_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
  });

  // Abort controller drives graceful shutdown.
  const controller = new AbortController();

  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} received — finishing current job then exiting`);
    controller.abort();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await loop.run(controller.signal);
    console.log("[worker] loop exited cleanly");
  } catch (err) {
    console.error("[worker] fatal error:", err);
    process.exit(1);
  } finally {
    await pool.end().catch((e) => console.error("[worker] pool.end failed:", e));
  }

  process.exit(0);
}

void main();
