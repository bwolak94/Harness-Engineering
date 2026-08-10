import { applyMultiTenancy, applySchema } from "@harness/adapters-postgres";
import { parseEnv } from "@harness/contracts/env";
import { Pool } from "pg";
import { compose } from "./composition/compose.js";

// ---------------------------------------------------------------------------
// Composition root — the only place where process.env is accessed.
// All wiring happens in compose(); main() only boots and shuts down.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = parseEnv();

  // Apply idempotent DDL migrations on every boot — safe for dev and prod restarts.
  const bootstrapPool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await applySchema(bootstrapPool);
    await applyMultiTenancy(bootstrapPool);
    console.log("[harness] schema applied");
  } finally {
    await bootstrapPool.end();
  }

  const { fastify, gateway, retentionJob, rollupJob } = compose(env);

  // Start background jobs after composition.
  rollupJob.start();
  retentionJob.start();

  // Graceful shutdown — SIGTERM from container orchestrator (Kubernetes, Docker).
  // Budget: 5 s to finish in-flight steps, then force-exit.
  const shutdown = async (signal: string) => {
    console.log(`[harness] ${signal} received — shutting down`);
    const deadline = setTimeout(() => {
      console.error("[harness] shutdown timed out, force-exiting");
      process.exit(1);
    }, 5_000);

    try {
      rollupJob.stop();
      retentionJob.stop();
      await fastify.close(); // stops accepting new HTTP/WS connections
      await gateway.close(); // closes open WS subscriptions
      clearTimeout(deadline);
      console.log("[harness] shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("[harness] error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await fastify.listen({ port: env.PORT, host: env.HOST });
    console.log(`[harness] listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  } catch (err) {
    console.error("[harness] failed to start:", err);
    process.exit(1);
  }
}

void main();
