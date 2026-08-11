import { createMcpTools } from "@harness/adapters-egress";
import type { McpServerConfig } from "@harness/adapters-egress";
import type { EgressPort, ToolCallError, ToolRegistryPort } from "@harness/core";
import { ok } from "@harness/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "./problem-details.js";

// ---------------------------------------------------------------------------
// MCP HTTP routes
//
// POST /mcp/discover — call tools/list on a given MCP server and return
//                      the tool definitions. No side effects; useful for
//                      verifying connectivity before persisting a server config.
//
// POST /mcp/register — discover tools from a given MCP server URL and register
//                      them in the shared InMemoryToolRegistry for the lifetime
//                      of this process. Useful in development / single-tenant mode.
//                      Multi-tenant per-workflow loading is handled at the
//                      workflow layer (T-E follow-up).
// ---------------------------------------------------------------------------

const DiscoverBodySchema = z.object({
  url: z.string().url("url must be a valid URL"),
  tenantId: z.string().min(1).default("system"),
  allowedHosts: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

interface RegisteredServer {
  url: string;
  tenantId: string;
  toolNames: string[];
  registeredAt: string;
}

export function registerMcpRoutes(
  fastify: FastifyInstance,
  egress: EgressPort,
  toolRegistry: ToolRegistryPort,
): void {
  // In-process list of servers registered in this session.
  const registeredServers: RegisteredServer[] = [];

  // GET /mcp/servers — list servers registered in this process lifetime
  fastify.get("/mcp/servers", (_req, reply) => {
    reply.send({ servers: registeredServers });
  });
  // POST /mcp/discover — return tool definitions from a given MCP server
  fastify.post("/mcp/discover", async (req, reply) => {
    const parsed = DiscoverBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }
    const { url, tenantId, allowedHosts, headers } = parsed.data;
    const hostname = new URL(url).hostname;
    const config: McpServerConfig = {
      url,
      tenantId,
      allowedHosts: allowedHosts ?? [hostname],
      ...(headers && { headers }),
    };
    try {
      const tools = await createMcpTools(config, egress);
      reply.send({
        url,
        count: tools.length,
        tools: tools.map((t) => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.inputSchema,
        })),
      });
    } catch (err) {
      return badRequest(reply, req, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /mcp/register — discover and register tools into the shared registry
  fastify.post("/mcp/register", async (req, reply) => {
    const parsed = DiscoverBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }
    const { url, tenantId, allowedHosts, headers } = parsed.data;
    const hostname = new URL(url).hostname;
    const config: McpServerConfig = {
      url,
      tenantId,
      allowedHosts: allowedHosts ?? [hostname],
      ...(headers && { headers }),
    };
    try {
      const tools = await createMcpTools(config, egress);
      for (const tool of tools) {
        // Wrap the MCP tool's execute (returns Promise<unknown>) into the
        // ToolExecutor signature (returns Promise<Result<unknown, ToolCallError>>).
        toolRegistry.register({
          definition: tool.definition,
          execute: async (
            args: unknown,
          ): Promise<import("@harness/core").Result<unknown, ToolCallError>> => {
            const result = await tool.execute(args);
            return ok(result);
          },
        });
      }
      const toolNames = tools.map((t) => t.definition.name);
      registeredServers.push({ url, tenantId, toolNames, registeredAt: new Date().toISOString() });
      reply.status(200).send({ registered: toolNames });
    } catch (err) {
      return badRequest(reply, req, err instanceof Error ? err.message : String(err));
    }
  });
}
