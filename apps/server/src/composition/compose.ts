import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import {
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryToolRegistry,
} from "@harness/adapters-memory";
import type { Env } from "@harness/contracts/env";
import type { IdPort, ModelContext, ModelPort } from "@harness/core";
import { WallClock, ok } from "@harness/core";
import { createDefaultToolExecutors } from "@harness/core/tools";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { registerAuthMiddleware } from "../http/auth-middleware.js";
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
// StubModelPort — immediate text response for local dev (T04).
// Replaced by real LLM adapter once adapters-llm is implemented (T05).
// ---------------------------------------------------------------------------

class StubModelPort implements ModelPort {
  async generate(ctx: ModelContext) {
    const goal = ctx.messages.find((m) => m.role === "user")?.content ?? "(unknown)";
    return ok({
      content: `[stub] Completed goal: ${goal}`,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop" as const,
    });
  }
}

// ---------------------------------------------------------------------------
// compose — wire all adapters and return the running app handle
// ---------------------------------------------------------------------------

export interface App {
  fastify: FastifyInstance;
  gateway: WsGateway;
  service: HarnessService;
}

export function compose(env: Env): App {
  // --- Ports ---
  const idPort: IdPort = new CryptoIdPort();
  const clock = new WallClock();
  const model: ModelPort = new StubModelPort();

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
    },
    eventLog,
    stateStore,
    idPort,
  });

  // --- HTTP ---
  const fastify = Fastify({ logger: env.NODE_ENV !== "test" });
  // Auth middleware runs before all routes; sets req.tenantContext from Bearer JWT.
  registerAuthMiddleware(fastify, env.JWT_SECRET);
  registerWorkflowRoutes(fastify, service);
  // Tenant management and tool-definition routes (T15).
  // `new Pool` is lazy — it does not connect until the first query, so this is
  // safe even when running tests with in-memory adapters.
  const dbPool = new Pool({ connectionString: env.DATABASE_URL });
  registerTenantRoutes(fastify, dbPool);

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

  return { fastify, gateway, service };
}
