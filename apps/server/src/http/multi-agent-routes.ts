import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MultiAgentService } from "../service/multi-agent-service.js";
import { badRequest } from "./problem-details.js";

// ---------------------------------------------------------------------------
// Multi-agent HTTP routes
//
// POST /workflows/multi — route a goal to the best-fit specialist agent
//   Returns 202 with { workflowId, selectedAgent, routedBy } immediately.
//   The caller can subscribe to /stream?workflowId=... for live events.
// ---------------------------------------------------------------------------

const StartMultiBodySchema = z.object({
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

export function registerMultiAgentRoutes(
  fastify: FastifyInstance,
  service: MultiAgentService,
): void {
  // POST /workflows/multi — start a routed multi-agent workflow
  fastify.post("/workflows/multi", async (req, reply) => {
    const parsed = StartMultiBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }

    const { goal, budget: rawBudget, constraints, metadata } = parsed.data;

    const result = await service.start({
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
}
