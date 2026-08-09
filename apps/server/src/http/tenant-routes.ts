import { withTenantCtx } from "@harness/adapters-postgres";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAuth } from "./auth-middleware.js";
import { badRequest, notFound } from "./problem-details.js";
import { requireRole } from "./rbac.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const CreateTenantBody = z.object({
  id: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  plan: z.enum(["free", "starter", "growth", "unlimited"]).default("free"),
  region: z.string().default("eu-west"),
});

const CreateToolDefinitionBody = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["builtin", "declarative", "mcp", "webhook"]).default("declarative"),
  spec: z.record(z.unknown()),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  dangerous: z.boolean().default(false),
  idempotent: z.boolean().default(true),
});

const AddMemberBody = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers tenant management and tool-definition routes.
 *
 * All routes require authentication (Bearer JWT). Admin routes enforce the
 * `admin` role minimum via the requireRole preHandler.
 *
 * POST   /tenants                        — create tenant (platform admin, no RLS)
 * GET    /tenants/:id                    — get tenant metadata
 * POST   /tenants/:id/members            — add member (admin+)
 * GET    /tenants/:id/tool-definitions   — list tool definitions
 * POST   /tenants/:id/tool-definitions   — create tool definition + first version (admin+)
 */
export function registerTenantRoutes(fastify: FastifyInstance, pool: Pool): void {
  // POST /tenants — platform admin creates a tenant (bypasses RLS via superuser pool)
  fastify.post("/tenants", { preHandler: requireRole("owner") }, async (req, reply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    const parsed = CreateTenantBody.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
    }
    const { id, slug, plan, region } = parsed.data;

    // Tenant creation runs as the platform admin in the caller's tenant context
    // so they can only create tenants they're authorised to manage.
    await withTenantCtx(pool, ctx.tenantId, async (client) => {
      await client.query("INSERT INTO tenants (id, slug, plan, region) VALUES ($1, $2, $3, $4)", [
        id,
        slug,
        plan,
        region,
      ]);
    });

    reply.status(201).send({ id, slug, plan, region, status: "active" });
  });

  // GET /tenants/:id
  fastify.get<{ Params: { id: string } }>("/tenants/:id", async (req, reply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    const { id } = req.params;
    const row = await withTenantCtx(pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        "SELECT id, slug, plan, region, status, created_at FROM tenants WHERE id = $1",
        [id],
      );
      return result.rows[0] ?? null;
    });

    if (!row) return notFound(reply, req, `Tenant '${id}' not found`);
    reply.send(row);
  });

  // POST /tenants/:id/members — add a member to a tenant
  fastify.post<{ Params: { id: string } }>(
    "/tenants/:id/members",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const ctx = requireAuth(req, reply);
      if (!ctx) return;

      const parsed = AddMemberBody.safeParse(req.body);
      if (!parsed.success) {
        return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
      }
      const { userId, email, role } = parsed.data;
      const tenantId = req.params.id;

      await withTenantCtx(pool, ctx.tenantId, async (client) => {
        // Upsert the user row (users belong to a home tenant, can be members of many)
        await client.query(
          `INSERT INTO users (id, email, tenant_id) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [userId, email, tenantId],
        );
        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [tenantId, userId, role],
        );
      });

      reply.status(201).send({ tenantId, userId, role });
    },
  );

  // GET /tenants/:id/tool-definitions
  fastify.get<{ Params: { id: string } }>("/tenants/:id/tool-definitions", async (req, reply) => {
    const ctx = requireAuth(req, reply);
    if (!ctx) return;

    const rows = await withTenantCtx(pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, name, kind, current_version, status, created_at
           FROM tool_definitions
           ORDER BY created_at DESC`,
      );
      return result.rows;
    });

    reply.send({ toolDefinitions: rows });
  });

  // POST /tenants/:id/tool-definitions — create definition + first version
  fastify.post<{ Params: { id: string } }>(
    "/tenants/:id/tool-definitions",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const ctx = requireAuth(req, reply);
      if (!ctx) return;

      const parsed = CreateToolDefinitionBody.safeParse(req.body);
      if (!parsed.success) {
        return badRequest(reply, req, parsed.error.errors.map((e) => e.message).join("; "));
      }
      const { id, name, kind, spec, inputSchema, outputSchema, dangerous, idempotent } =
        parsed.data;
      const tenantId = req.params.id;

      await withTenantCtx(pool, ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO tool_definitions (id, tenant_id, name, kind)
           VALUES ($1, $2, $3, $4)`,
          [id, tenantId, name, kind],
        );
        await client.query(
          `INSERT INTO tool_versions
             (id, tool_id, tenant_id, version, spec, input_schema, output_schema, dangerous, idempotent)
           VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
          [
            `${id}-v1`,
            id,
            tenantId,
            JSON.stringify(spec),
            JSON.stringify(inputSchema ?? {}),
            JSON.stringify(outputSchema ?? {}),
            dangerous,
            idempotent,
          ],
        );
      });

      reply.status(201).send({ id, name, kind, version: 1 });
    },
  );
}
