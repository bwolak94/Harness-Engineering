import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Control-plane schema — tenant configuration, RBAC, tool versioning.
 *
 * All tables carry `tenant_id` and have RLS enabled (see migration 0002).
 * The `tenants` table is special: its `tenant_id` is a generated column
 * equal to `id`, so the same uniform RLS policy expression applies.
 */

export const tenantsTable = pgTable("tenants", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  region: text("region").notNull().default("eu-west"),
  status: text("status").notNull().default("active"),
  /** Generated always as (id) — satisfies the uniform RLS policy. */
  tenantId: text("tenant_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  authProviderId: text("auth_provider_id"),
  tenantId: text("tenant_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membershipsTable = pgTable(
  "memberships",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const platformApiKeysTable = pgTable("platform_api_keys", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantDeksTable = pgTable("tenant_deks", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  kmsKeyId: text("kms_key_id").notNull(),
  version: integer("version").notNull().default(1),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolDefinitionsTable = pgTable("tool_definitions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("builtin"),
  currentVersion: integer("current_version").notNull().default(1),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * toolVersionsTable — append-only.
 *
 * A DB trigger rejects UPDATE and DELETE. Application code creates a new
 * version row and updates `tool_definitions.current_version` instead.
 */
export const toolVersionsTable = pgTable("tool_versions", {
  id: text("id").primaryKey(),
  toolId: text("tool_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  version: integer("version").notNull(),
  spec: jsonb("spec").notNull(),
  inputSchema: jsonb("input_schema").notNull().default({}),
  outputSchema: jsonb("output_schema").notNull().default({}),
  dangerous: boolean("dangerous").notNull().default(false),
  idempotent: boolean("idempotent").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpServersTable = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  url: text("url").notNull(),
  authSecretId: text("auth_secret_id"),
  allowedTools: text("allowed_tools").array().notNull().default([]),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentsTable = pgTable("agents", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  modelConfig: jsonb("model_config").notNull().default({}),
  toolIds: text("tool_ids").array().notNull().default([]),
  systemPromptRef: text("system_prompt_ref"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policiesTable = pgTable("policies", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  scope: text("scope").notNull(),
  rules: jsonb("rules").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planLimitsTable = pgTable("plan_limits", {
  plan: text("plan").primaryKey(),
  maxConcurrency: integer("max_concurrency").notNull().default(5),
  maxSteps: integer("max_steps").notNull().default(20),
  monthlyRuns: integer("monthly_runs").notNull().default(100),
  retentionDays: integer("retention_days").notNull().default(30),
  maxCustomTools: integer("max_custom_tools").notNull().default(10),
});

// ---------------------------------------------------------------------------
// Data-plane additions
// ---------------------------------------------------------------------------

export const usageRollupsDailyTable = pgTable(
  "usage_rollups_daily",
  {
    tenantId: text("tenant_id").notNull(),
    day: text("day").notNull(), // DATE as text (YYYY-MM-DD)
    runs: integer("runs").notNull().default(0),
    steps: integer("steps").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),
    toolErrors: integer("tool_errors").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.day] })],
);

export const approvalsTable = pgTable("approvals", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  stepSeq: integer("step_seq").notNull(),
  context: jsonb("context").notNull().default({}),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  defaultAction: text("default_action").notNull().default("reject"),
  decision: text("decision"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobQueueTable = pgTable("job_queue", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  priority: integer("priority").notNull().default(0),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  lockedBy: text("locked_by"),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stepLeasesTable = pgTable("step_leases", {
  workflowId: text("workflow_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workerId: text("worker_id").notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
});
