import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FlowService } from "../service/flow-service.js";
import { badRequest, notFound } from "./problem-details.js";

// ---------------------------------------------------------------------------
// Flow HTTP routes
//
// GET  /flows              — list all registered flow definitions
// POST /flows/:id/run      — start a named flow, returns FlowRunResult with
//                           child workflowIds for WS subscription
// ---------------------------------------------------------------------------

const RunFlowBodySchema = z.object({
  goal: z.string().min(1, "goal is required"),
  budget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxSteps: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
    })
    .optional(),
});

export function registerFlowRoutes(fastify: FastifyInstance, service: FlowService): void {
  // GET /flows — return all flow definitions (id, name, description, pattern, steps)
  fastify.get("/flows", (_req, reply) => {
    reply.send({ flows: service.list() });
  });

  // POST /flows/:id/run — execute a named flow
  fastify.post<{ Params: { id: string } }>("/flows/:id/run", async (req, reply) => {
    const spec = service.get(req.params.id);
    if (!spec) {
      return notFound(reply, req, `Flow '${req.params.id}' not found`);
    }

    const parsed = RunFlowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }

    const { goal, budget } = parsed.data;

    const result = await service.run(
      req.params.id,
      goal,
      budget !== undefined
        ? (Object.fromEntries(Object.entries(budget).filter(([, v]) => v !== undefined)) as Partial<
            import("@harness/contracts").Budget
          >)
        : undefined,
    );

    reply.status(202).send(result);
  });
}
