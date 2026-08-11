import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { EgressService } from "@harness/adapters-egress";
import { VercelAiModelPort } from "@harness/adapters-llm";
import {
  DEFAULT_AGENTS,
  DEFAULT_FLOWS,
  DEFAULT_RULES,
  InMemoryAgentRegistry,
  InMemoryRateLimiter,
  InMemoryToolRegistry,
} from "@harness/adapters-memory";
import {
  PostgresEventLog,
  PostgresStateStore,
  RetentionJob,
  UsageRollupJob,
  createDb,
} from "@harness/adapters-postgres";
import type { HarnessEvent } from "@harness/contracts";
import type { Env } from "@harness/contracts/env";
import type { ModelContext, ModelPort } from "@harness/core";
import { ok } from "@harness/core";
import type { IdPort } from "@harness/core";
import { NoopBlobStorePort, NoopSecretPort, WallClock } from "@harness/core";
import {
  EscalationClassifier,
  FlowRunner,
  Router,
  RuleBasedClassifier,
  Supervisor,
} from "@harness/core";
import { createDefaultToolExecutors } from "@harness/core/tools";
import {
  TracingModelAdapter,
  createHarnessMetrics,
  withBudgetThreshold,
  withTracing,
} from "@harness/observability";
import { trace } from "@opentelemetry/api";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthMiddleware } from "../http/auth-middleware.js";
import { registerBillingRoutes } from "../http/billing-routes.js";
import { registerFlowRoutes } from "../http/flow-routes.js";
import { registerLifecycleRoutes } from "../http/lifecycle-routes.js";
import { registerMcpRoutes } from "../http/mcp-routes.js";
import { registerMultiAgentRoutes } from "../http/multi-agent-routes.js";
import { registerObservabilityRoutes } from "../http/observability-routes.js";
import { registerRateLimitMiddleware } from "../http/rate-limit-middleware.js";
import { registerSandboxRoutes } from "../http/sandbox-routes.js";
import { registerTenantRoutes } from "../http/tenant-routes.js";
import { registerWorkflowRoutes } from "../http/workflow-routes.js";
import { CompositeEventLog } from "../service/composite-event-log.js";
import { EventBus } from "../service/event-bus.js";
import { FlowService } from "../service/flow-service.js";
import { HarnessService } from "../service/harness-service.js";
import { MultiAgentService } from "../service/multi-agent-service.js";
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
  multiAgentService: MultiAgentService;
  flowService: FlowService;
  retentionJob: RetentionJob;
  rollupJob: UsageRollupJob;
}

// ---------------------------------------------------------------------------
// StubModelPort — deterministic text-only model for NODE_ENV=test.
//
// Used in E2E tests so CI does not require a real LLM API key.
// Returns "4" so that assertions like toContainText("4") pass.
// ---------------------------------------------------------------------------

class StubModelPort implements ModelPort {
  async generate(_ctx: ModelContext) {
    return ok({
      content: "4",
      toolCalls: [] as const,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      finishReason: "stop" as const,
    });
  }
}

export function compose(env: Env): App {
  // --- Observability — tracer and metrics bound to the global OTel SDK ---
  const tracer = trace.getTracer("@harness/server", "0.0.0");
  const harnessMetrics = createHarnessMetrics();

  // --- Ports ---
  const idPort: IdPort = new CryptoIdPort();
  const clock = new WallClock();
  // In test mode, use a stub that never calls the real LLM so E2E tests
  // work without a valid API key.
  const rawModel: ModelPort =
    env.NODE_ENV === "test"
      ? new StubModelPort()
      : new VercelAiModelPort({
          baseUrl: env.LLM_BASE_URL,
          apiKey: env.LLM_API_KEY,
          model: env.LLM_MODEL,
        });
  // Wrap the model port to emit gen_ai.chat spans and token/cost metrics.
  const model = new TracingModelAdapter(rawModel, tracer, harnessMetrics);

  // --- Egress — SSRF-safe HTTP client used by MCP tool calls ---
  // NoopSecretPort: secrets are resolved lazily per-tenant at call time (T16).
  // NoopBlobStorePort: large response claim-checks are a production concern.
  const egress = new EgressService(new NoopSecretPort(), new NoopBlobStorePort());

  // --- Storage — durable Postgres adapters backed by the shared pool ---
  const { db, pool: dbPool } = createDb(env.DATABASE_URL);
  const rawEventLog = new PostgresEventLog(db);
  const stateStore = new PostgresStateStore(db);

  // --- Observer ---
  const bus = new EventBus();
  const eventLog = new CompositeEventLog(rawEventLog, bus);

  // --- Tool registry ---
  const toolRegistry = new InMemoryToolRegistry();
  for (const executor of createDefaultToolExecutors()) {
    toolRegistry.register(executor);
  }

  const runtimeDeps = {
    model,
    eventLog,
    stateStore,
    toolRegistry,
    clock,
    idPort,
    // withBudgetThreshold emits budget.threshold.exceeded events at 80% of any limit.
    // withTracing wraps each tool call in an OTel span (child of the workflow span).
    // Order matters: budget threshold runs first so it fires before the tracing span closes.
    middleware: [withBudgetThreshold(), withTracing(tracer, harnessMetrics)],
    livePublish: (event: HarnessEvent) => bus.publish(event),
  };

  // --- Facade ---
  const service = new HarnessService({
    runtimeDeps,
    eventLog,
    stateStore,
    idPort,
  });

  // --- Multi-agent router + service ---
  const agentRegistry = new InMemoryAgentRegistry(DEFAULT_AGENTS);
  const router = new Router(
    [new RuleBasedClassifier(DEFAULT_RULES), new EscalationClassifier()],
    agentRegistry,
  );
  const multiAgentService = new MultiAgentService({
    runtimeDeps,
    eventLog,
    stateStore,
    idPort,
    router,
    agentRegistry,
  });

  // --- Flow runner + service ---
  const supervisor = new Supervisor();
  const flowRunner = new FlowRunner({
    agentRegistry,
    toolRegistry,
    supervisor,
    model,
    eventLog,
    stateStore,
    clock,
    idPort,
    middleware: runtimeDeps.middleware,
    livePublish: runtimeDeps.livePublish,
  });
  const flowService = new FlowService({ flows: DEFAULT_FLOWS, flowRunner });

  // --- Rate limiter (in-memory; swap to RedisRateLimiter in production) ---
  const rateLimiter = new InMemoryRateLimiter();

  // --- HTTP ---
  const fastify = Fastify({ logger: env.NODE_ENV !== "test" });
  // Auth middleware runs before all routes; sets req.tenantContext from Bearer JWT.
  registerAuthMiddleware(fastify, env.JWT_SECRET);
  // Rate limit after auth so we have tenantContext available.
  registerRateLimitMiddleware(fastify, rateLimiter, env.RATE_LIMIT_RPM);
  registerWorkflowRoutes(fastify, service);
  registerMultiAgentRoutes(fastify, multiAgentService);
  registerFlowRoutes(fastify, flowService);
  registerMcpRoutes(fastify, egress, toolRegistry);
  registerSandboxRoutes(fastify, toolRegistry);
  // Tenant management, observability, billing, and lifecycle routes share the pool.
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

  return { fastify, gateway, service, multiAgentService, flowService, retentionJob, rollupJob };
}
