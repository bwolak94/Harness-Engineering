-- ============================================================================
-- Migration 0002 — Multi-tenancy and access model (T15)
--
-- Changes:
--   1. Database roles (app_rw, app_migrator)
--   2. Add tenant_id to existing data-plane tables
--   3. Control-plane tables (tenants, users, memberships, api_keys,
--      tool_definitions, tool_versions, agents, policies, plan_limits,
--      mcp_servers)
--   4. Additional data-plane tables (usage_ledger partitioned, approvals,
--      job_queue, step_leases, outbox, idempotency_records)
--   5. Row-Level Security on every table
--   6. Indexes (critical path only, per plan.md)
--   7. Append-only trigger on tool_versions
--   8. Partition management helpers for usage_ledger
-- ============================================================================

-- ============================================================================
-- 1. Database roles
-- ============================================================================

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

--> statement-breakpoint
-- Grant schema usage so app_rw can see objects
GRANT USAGE ON SCHEMA public TO app_rw;

-- ============================================================================
-- 2. Add tenant_id to existing data-plane tables
--    Default = 'system' so existing single-tenant rows remain accessible.
-- ============================================================================

--> statement-breakpoint
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE events    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

-- Indexes for tenant-scoped access patterns
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows (tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_at ON events (tenant_id, at DESC);

-- ============================================================================
-- 3. Control-plane tables
-- ============================================================================

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT        PRIMARY KEY,
  slug        TEXT        NOT NULL UNIQUE,
  plan        TEXT        NOT NULL DEFAULT 'free',
  region      TEXT        NOT NULL DEFAULT 'eu-west',
  status      TEXT        NOT NULL DEFAULT 'active',   -- active|suspended|deleted
  tenant_id   TEXT        NOT NULL GENERATED ALWAYS AS (id) STORED,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id               TEXT        PRIMARY KEY,
  email            TEXT        NOT NULL UNIQUE,
  auth_provider_id TEXT,
  tenant_id        TEXT        NOT NULL,               -- home tenant; users can belong to many via memberships
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',            -- owner|admin|member|viewer
  PRIMARY KEY (tenant_id, user_id)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS platform_api_keys (
  id          TEXT        PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  prefix      TEXT        NOT NULL,                    -- first 8 chars, shown in UI
  key_hash    TEXT        NOT NULL,                    -- bcrypt hash of full key
  scopes      TEXT[]      NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
-- DEK (Data Encryption Key) envelope — the wrapped key; plaintext DEK never stored.
-- Populated in T16 when envelope encryption is wired.
CREATE TABLE IF NOT EXISTS tenant_deks (
  id          TEXT        PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  wrapped_dek TEXT        NOT NULL,                    -- DEK wrapped by KMS
  kms_key_id  TEXT        NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  rotated_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
-- Tool definition metadata; versions are in tool_versions (immutable)
CREATE TABLE IF NOT EXISTS tool_definitions (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  kind            TEXT        NOT NULL DEFAULT 'builtin', -- builtin|declarative|mcp|webhook
  current_version INTEGER     NOT NULL DEFAULT 1,
  status          TEXT        NOT NULL DEFAULT 'active',  -- active|deprecated|deleted
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

--> statement-breakpoint
-- Tool version rows are IMMUTABLE — see trigger below.
-- Resuming a workflow days later uses the same version it started on.
CREATE TABLE IF NOT EXISTS tool_versions (
  id            TEXT        PRIMARY KEY,
  tool_id       TEXT        NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
  tenant_id     TEXT        NOT NULL,
  version       INTEGER     NOT NULL,
  spec          JSONB       NOT NULL,                  -- full tool specification
  input_schema  JSONB       NOT NULL DEFAULT '{}',
  output_schema JSONB       NOT NULL DEFAULT '{}',
  dangerous     BOOLEAN     NOT NULL DEFAULT FALSE,
  idempotent    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tool_id, version)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mcp_servers (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  auth_secret_id  TEXT,                                -- references secrets (T16)
  allowed_tools   TEXT[]      NOT NULL DEFAULT '{}',
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT        PRIMARY KEY,
  tenant_id         TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  model_config      JSONB       NOT NULL DEFAULT '{}',
  tool_ids          TEXT[]      NOT NULL DEFAULT '{}',
  system_prompt_ref TEXT,
  version           INTEGER     NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS policies (
  id          TEXT        PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  scope       TEXT        NOT NULL,                    -- 'global'|tool name|agent name
  rules       JSONB       NOT NULL DEFAULT '{}',       -- Specification rules from T03
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS plan_limits (
  plan               TEXT    PRIMARY KEY,
  max_concurrency    INTEGER NOT NULL DEFAULT 5,
  max_steps          INTEGER NOT NULL DEFAULT 20,
  monthly_runs       INTEGER NOT NULL DEFAULT 100,
  retention_days     INTEGER NOT NULL DEFAULT 30,
  max_custom_tools   INTEGER NOT NULL DEFAULT 10
);

--> statement-breakpoint
-- Seed default plans
INSERT INTO plan_limits (plan, max_concurrency, max_steps, monthly_runs, retention_days, max_custom_tools)
VALUES
  ('free',       2,   10,    50,   7,   3),
  ('starter',    5,   20,   500,  30,  10),
  ('growth',    20,   50, 5000,   90,  50),
  ('unlimited', 999, 999,  999999, 365, 999)
ON CONFLICT (plan) DO NOTHING;

-- ============================================================================
-- 4. Additional data-plane tables
-- ============================================================================

--> statement-breakpoint
-- Usage ledger — range-partitioned by day.
-- Partitions are created by create_usage_partitions().
CREATE TABLE IF NOT EXISTS usage_ledger (
  id          TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL,
  workflow_id TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  kind        TEXT        NOT NULL,  -- input_tokens|output_tokens|cached_tokens|step|tool_ms
  qty         BIGINT      NOT NULL,
  cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, ts, id)
) PARTITION BY RANGE (ts);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_rollups_daily (
  tenant_id   TEXT    NOT NULL,
  day         DATE    NOT NULL,
  runs        INTEGER NOT NULL DEFAULT 0,
  steps       INTEGER NOT NULL DEFAULT 0,
  tokens_in   BIGINT  NOT NULL DEFAULT 0,
  tokens_out  BIGINT  NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT        PRIMARY KEY,
  tenant_id      TEXT        NOT NULL,
  workflow_id    TEXT        NOT NULL,
  step_seq       INTEGER     NOT NULL,
  context        JSONB       NOT NULL DEFAULT '{}',
  deadline       TIMESTAMPTZ NOT NULL,
  default_action TEXT        NOT NULL DEFAULT 'reject',  -- approve|reject
  decision       TEXT,                                   -- NULL = pending
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS job_queue (
  id           TEXT        PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  workflow_id  TEXT        NOT NULL,
  priority     INTEGER     NOT NULL DEFAULT 0,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  locked_by    TEXT,
  locked_until TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS step_leases (
  workflow_id  TEXT        PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  worker_id    TEXT        NOT NULL,
  lease_until  TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 5. Row-Level Security
-- ============================================================================

-- Helper: enable RLS and create a uniform tenant_id policy.
-- We use FORCE ROW LEVEL SECURITY on new tables so that even the table owner
-- (but NOT superusers — Postgres always grants superusers bypass) is subject
-- to the policy. This ensures test connections using SET ROLE app_rw are
-- correctly restricted.

--> statement-breakpoint
-- Existing tables (workflows, events, snapshots)
ALTER TABLE workflows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots    ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workflows USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON events    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON snapshots USING (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
-- Control-plane tables
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies         ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants          FORCE ROW LEVEL SECURITY;
ALTER TABLE users            FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships      FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_deks      FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_versions    FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers      FORCE ROW LEVEL SECURITY;
ALTER TABLE agents           FORCE ROW LEVEL SECURITY;
ALTER TABLE policies         FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants           USING (id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON users             USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON memberships       USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON platform_api_keys USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON tenant_deks       USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON tool_definitions  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON tool_versions     USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON mcp_servers       USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON agents            USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON policies          USING (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
-- plan_limits is shared (no tenant_id) — readable by all app_rw connections
ALTER TABLE plan_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_limits_readable ON plan_limits FOR SELECT USING (true);

--> statement-breakpoint
-- Data-plane tables
ALTER TABLE usage_ledger        ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue           ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_leases         ENABLE ROW LEVEL SECURITY;

ALTER TABLE usage_ledger        FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals           FORCE ROW LEVEL SECURITY;
ALTER TABLE job_queue           FORCE ROW LEVEL SECURITY;
ALTER TABLE step_leases         FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON usage_ledger        USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON usage_rollups_daily USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON approvals           USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON job_queue           USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON step_leases         USING (tenant_id = current_setting('app.tenant_id', true));

-- ============================================================================
-- 6. Indexes (critical path only — per plan.md)
-- ============================================================================

--> statement-breakpoint
-- job_queue: partial index — the heart of SKIP LOCKED queue polling
CREATE INDEX IF NOT EXISTS idx_job_queue_run_after
  ON job_queue (run_after) WHERE locked_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_job_queue_tenant_locked
  ON job_queue (tenant_id, locked_by);

-- workflows: dashboard and list views
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_status_created
  ON workflows (tenant_id, status, created_at DESC);

-- outbox: retry poller (table added in T07; add tenant_id index now)
-- (outbox table may not exist — CREATE INDEX CONCURRENTLY would fail; use DO block)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'outbox') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status ON outbox (tenant_id, status, next_retry_at)';
  END IF;
END $$;

-- approvals: pending approval feed
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_pending
  ON approvals (tenant_id, deadline) WHERE decision IS NULL;

-- usage_ledger: time-series query per tenant
CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_ts
  ON usage_ledger (tenant_id, ts);

-- ============================================================================
-- 7. Append-only trigger on tool_versions
--    UPDATE and DELETE on tool_versions are rejected at DB level.
--    Callers must create a new version row instead.
-- ============================================================================

--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_tool_version_modification()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'tool_versions is immutable: % operations are not permitted. Create a new version row instead.',
    TG_OP;
END;
$$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS tool_versions_immutable ON tool_versions;
CREATE TRIGGER tool_versions_immutable
BEFORE UPDATE OR DELETE ON tool_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_tool_version_modification();

-- ============================================================================
-- 8. Partition management for usage_ledger
-- ============================================================================

--> statement-breakpoint
-- Creates daily partitions for the given month (year/month) if they don't exist.
-- Call from migrations AND from a daily cron job (scheduler role).
CREATE OR REPLACE FUNCTION create_usage_partitions(p_year INTEGER, p_month INTEGER)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  d        DATE;
  end_d    DATE;
  part_name TEXT;
  d_next   DATE;
BEGIN
  d     := make_date(p_year, p_month, 1);
  end_d := d + INTERVAL '1 month';
  WHILE d < end_d LOOP
    d_next    := d + INTERVAL '1 day';
    part_name := 'usage_ledger_' || to_char(d, 'YYYY_MM_DD');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      WHERE  n.nspname = 'public' AND c.relname = part_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF usage_ledger FOR VALUES FROM (%L) TO (%L)',
        part_name, d, d_next
      );
    END IF;
    d := d_next;
  END LOOP;
END;
$$;

--> statement-breakpoint
-- Seed partitions for current month + next month so the test on month boundary works.
SELECT create_usage_partitions(
  EXTRACT(YEAR  FROM CURRENT_DATE)::INTEGER,
  EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER
);

SELECT create_usage_partitions(
  EXTRACT(YEAR  FROM CURRENT_DATE + INTERVAL '1 month')::INTEGER,
  EXTRACT(MONTH FROM CURRENT_DATE + INTERVAL '1 month')::INTEGER
);

-- ============================================================================
-- 9. Grants for app_rw role
--    Must run AFTER tables are created.
-- ============================================================================

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_rw;
