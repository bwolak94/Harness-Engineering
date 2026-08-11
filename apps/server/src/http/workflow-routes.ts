import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HarnessService } from "../service/harness-service.js";
import { badRequest, notFound } from "./problem-details.js";

// ---------------------------------------------------------------------------
// Workflow HTTP routes
//
// Controller imports only types from core — zero domain logic lives here.
// All business rules stay in HarnessService and HarnessRuntime.
// ---------------------------------------------------------------------------

const StartWorkflowBodySchema = z.object({
  goal: z.string().min(1, "goal is required"),
  budget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxSteps: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
    })
    .optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const EventsQuerySchema = z.object({
  fromSeq: z.coerce.number().int().nonnegative().default(0),
});

export function registerWorkflowRoutes(fastify: FastifyInstance, service: HarnessService): void {
  // POST /workflows — start a new workflow, returns 202 immediately
  fastify.post("/workflows", async (req, reply) => {
    const parsed = StartWorkflowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }
    const { goal, budget: rawBudget, constraints, metadata } = parsed.data;
    // Build opts conditionally to satisfy exactOptionalPropertyTypes: true.
    const result = service.start({
      goal,
      ...(rawBudget !== undefined && {
        budget: Object.fromEntries(
          Object.entries(rawBudget).filter(([, v]) => v !== undefined),
        ) as Partial<import("@harness/contracts").Budget>,
      }),
      ...(constraints !== undefined && { constraints }),
      ...(metadata !== undefined && { metadata }),
    });
    reply.status(202).send(result);
  });

  // GET /workflows/:id — return current state
  fastify.get<{ Params: { id: string } }>("/workflows/:id", async (req, reply) => {
    const state = await service.getState(req.params.id);
    if (!state) {
      return notFound(reply, req, `Workflow '${req.params.id}' not found`);
    }
    reply.send(state);
  });

  // GET /workflows/:id/events?fromSeq= — return events for a workflow
  fastify.get<{ Params: { id: string }; Querystring: { fromSeq?: string } }>(
    "/workflows/:id/events",
    async (req, reply) => {
      const parsed = EventsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return badRequest(reply, req, "fromSeq must be a non-negative integer");
      }
      const events = await service.getEvents(req.params.id, parsed.data.fromSeq);
      reply.send({ events });
    },
  );

  const ApprovalBodySchema = z.object({
    requestId: z.string().min(1, "requestId is required"),
    decidedBy: z.string().min(1).default("ui-user"),
    comment: z.string().optional(),
    reason: z.string().optional(),
  });

  // POST /workflows/:id/approve — record a human approval decision
  fastify.post<{ Params: { id: string } }>("/workflows/:id/approve", async (req, reply) => {
    const parsed = ApprovalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }
    const { requestId, decidedBy, comment } = parsed.data;
    const found = await service.approveRequest(req.params.id, requestId, decidedBy, comment);
    if (!found) return notFound(reply, req, `Workflow '${req.params.id}' not found`);
    reply.status(204).send();
  });

  // POST /workflows/:id/reject — record a human rejection decision
  fastify.post<{ Params: { id: string } }>("/workflows/:id/reject", async (req, reply) => {
    const parsed = ApprovalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }
    const { requestId, decidedBy, reason } = parsed.data;
    const found = await service.rejectRequest(req.params.id, requestId, decidedBy, reason);
    if (!found) return notFound(reply, req, `Workflow '${req.params.id}' not found`);
    reply.status(204).send();
  });
}
