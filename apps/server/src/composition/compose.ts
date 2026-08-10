import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { VercelAiModelPort } from "@harness/adapters-llm";
import {
  InMemoryEventLog,
  InMemoryRateLimiter,
  InMemoryStateStore,
  InMemoryToolRegistry,
} from "@harness/adapters-memory";
import { RetentionJob, UsageRollupJob } from "@harness/adapters-postgres";
import type { Env } from "@harness/contracts/env";
import type { IdPort } from "@harness/core";
import { WallClock } from "@harness/core";
import { createDefaultToolExecutors } from "@harness/core/tools";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { registerAuthMiddleware } from "../http/auth-middleware.js";
import { registerBillingRoutes } from "../http/billing-routes.js";
import { registerLifecycleRoutes } from "../http/lifecycle-routes.js";
import { registerObservabilityRoutes } from "../http/observability-routes.js";
import { registerRateLimitMiddleware } from "../http/rate-limit-middleware.js";
import { registerTenantRoutes } from "../http/tenant-routes.js";
import { registerWorkflowRoutes } from "../http/workflow-routes.js";
import { CompositeEventLog } from "../service/composite-event-log.js";
import { EventBus } from "../service/event-bus.js";
import { HarnessService } from "../service/harness-service.js";
import { WsGateway } from "../ws/ws-gateway.js";

// ---------------------------------------------------------------------------
// CryptoIdPort — Node.js 22+ built-in crypto.randomUUID()
// ---------------------------------------------------------------------------

class CryptoIdPort implements IdPort {
  newId(): string {
    return randomUUID();
  }
}

// ---------------------------------------------------------------------------
// compose — wire all adapters and return the running app handle
// ---------------------------------------------------------------------------

export interface App {
  fastify: FastifyInstance;
  gateway: WsGateway;
  service: HarnessService;
  retentionJob: RetentionJob;
  rollupJob: UsageRollupJob;
}

export function compose(env: Env): App {
  // --- Ports ---
  const idPort: IdPort = new CryptoIdPort();
  const clock = new WallClock();
  const model = new VercelAiModelPort({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  });

  // --- Storage (in-memory for T04; swap to Postgres adapters in T06) ---
  const rawEventLog = new InMemoryEventLog();
  const stateStore = new InMemoryStateStore();

  // --- Observer ---
  const bus = new EventBus();
  const eventLog = new CompositeEventLog(rawEventLog, bus);

  // --- Tool registry ---
  const toolRegistry = new InMemoryToolRegistry();
  for (const executor of createDefaultToolExecutors()) {
    toolRegistry.register(executor);
  }

  // --- Facade ---
  const service = new HarnessService({
    runtimeDeps: {
      model,
      eventLog,
      stateStore,
      toolRegistry,
      clock,
      idPort,
      middleware: [],
      livePublish: (event) => bus.publish(event),
    },
    eventLog,
    stateStore,
    idPort,
  });

  // --- Rate limiter (in-memory; swap to RedisRateLimiter in production) ---
  const rateLimiter = new InMemoryRateLimiter();

  // --- HTTP ---
  const fastify = Fastify({ logger: env.NODE_ENV !== "test" });
  // Auth middleware runs before all routes; sets req.tenantContext from Bearer JWT.
  registerAuthMiddleware(fastify, env.JWT_SECRET);
  // Rate limit after auth so we have tenantContext available.
  registerRateLimitMiddleware(fastify, rateLimiter, env.RATE_LIMIT_RPM);
  registerWorkflowRoutes(fastify, service);
  // Tenant management and tool-definition routes (T15).
  // `new Pool` is lazy — it does not connect until the first query, so this is
  // safe even when running tests with in-memory adapters.
  const dbPool = new Pool({ connectionString: env.DATABASE_URL });
  registerTenantRoutes(fastify, dbPool);
  registerObservabilityRoutes(fastify, dbPool);
  registerBillingRoutes(fastify, dbPool);
  registerLifecycleRoutes(fastify, dbPool);

  // --- Background jobs ---
  // UsageRollupJob: rolls up usage_ledger into usage_rollups_daily every hour.
  // RetentionJob: drops expired partitions once per day.
  // Both are started lazily — the pool connects on first query.
  const rollupJob = new UsageRollupJob(dbPool);
  const retentionJob = new RetentionJob(dbPool);

  // --- WS ---
  const gateway = new WsGateway(service, bus);

  fastify.server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (url === "/stream" || url.startsWith("/stream?")) {
      gateway.handleUpgrade(req, socket as Socket, head);
    } else {
      socket.destroy();
    }
  });

  return { fastify, gateway, service, retentionJob, rollupJob };
}
