import type { ToolRegistryPort } from "@harness/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "./problem-details.js";

// ---------------------------------------------------------------------------
// Sandbox routes — direct tool invocation without a full workflow run.
//
// Intended for development, debugging, and the Sandbox UI tab.
// Dangerous tools (applyRepricing, etc.) are blocked here by design.
//
// GET  /sandbox/tools        — list registered tools with their schemas
// POST /sandbox/invoke       — invoke a single tool directly by name
// ---------------------------------------------------------------------------

const InvokeBodySchema = z.object({
  toolName: z.string().min(1, "toolName is required"),
  args: z.unknown().default({}),
});

export function registerSandboxRoutes(
  fastify: FastifyInstance,
  toolRegistry: ToolRegistryPort,
): void {
  // GET /sandbox/tools
  fastify.get("/sandbox/tools", (_req, reply) => {
    const tools = toolRegistry.list();
    reply.send({
      tools: tools.map((t) => ({
        name: t.definition.name,
        description: t.definition.description,
        dangerous: t.definition.dangerous,
        idempotent: t.definition.idempotent,
        costHint: t.definition.costHint,
        inputSchema: t.definition.inputSchema,
        outputSchema: t.definition.outputSchema,
      })),
    });
  });

  // POST /sandbox/invoke
  fastify.post("/sandbox/invoke", async (req, reply) => {
    const parsed = InvokeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }

    const { toolName, args } = parsed.data;
    const executor = toolRegistry.get(toolName);
    if (!executor) {
      return notFound(reply, req, `Tool '${toolName}' not found in registry`);
    }

    if (executor.definition.dangerous) {
      return reply.status(403).send({
        status: 403,
        title: "Forbidden",
        detail: `Tool '${toolName}' is marked dangerous and cannot be invoked via sandbox`,
      });
    }

    const result = await executor.execute(args);

    if (result.ok) {
      return reply.send({ ok: true, result: result.value });
    }
    return reply.status(422).send({ ok: false, error: result.error });
  });
}
