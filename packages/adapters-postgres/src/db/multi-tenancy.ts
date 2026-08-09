import type { Pool } from "pg";

/**
 * MULTI_TENANCY_SQL — full DDL for the multi-tenancy schema additions.
 *
 * Mirrors 0002_multi_tenancy.sql but kept as an inline constant so
 * Testcontainers tests can run it via `pool.query()` without any file-path
 * resolution. The SQL is split on `--> statement-breakpoint` and each
 * statement is executed individually so partial failures surface clearly.
 *
 * Usage:
 *   await applyMultiTenancy(pool);  // after applySchema(pool)
 */
export const MULTI_TENANCY_SQL = /* sql */ `
-- 1. Roles
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

GRANT USAGE ON SCHEMA public TO app_rw;

-- 2. tenant_id on existing tables
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE events    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows (tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_at ON events (tenant_id, at DESC);

-- 3. Control-plane tables
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT        PRIMARY KEY,
  slug        TEXT        NOT NULL UNIQUE,
  plan        TEXT        NOT NULL DEFAULT 'free',
  region      TEXT        NOT NULL DEFAULT 'eu-west',
  status      TEXT        NOT NULL DEFAULT 'active',
  tenant_id   TEXT        GENERATED ALWAYS AS (id) STORED NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id               TEXT        PRIMARY KEY,
  email            TEXT        NOT NULL UNIQUE,
  auth_provider_id TEXT,
  tenant_id        TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS platform_api_keys (
  id           TEXT        PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  prefix       TEXT        NOT NULL,
  key_hash     TEXT        NOT NULL,
  scopes       TEXT[]      NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_deks (
  id          TEXT        PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  wrapped_dek TEXT        NOT NULL,
  kms_key_id  TEXT        NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  rotated_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tool_definitions (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  kind            TEXT        NOT NULL DEFAULT 'builtin',
  current_version INTEGER     NOT NULL DEFAULT 1,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS tool_versions (
  id            TEXT        PRIMARY KEY,
  tool_id       TEXT        NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
  tenant_id     TEXT        NOT NULL,
  version       INTEGER     NOT NULL,
  spec          JSONB       NOT NULL,
  input_schema  JSONB       NOT NULL DEFAULT '{}',
  output_schema JSONB       NOT NULL DEFAULT '{}',
  dangerous     BOOLEAN     NOT NULL DEFAULT FALSE,
  idempotent    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tool_id, version)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id             TEXT        PRIMARY KEY,
  tenant_id      TEXT        NOT NULL,
  url            TEXT        NOT NULL,
  auth_secret_id TEXT,
  allowed_tools  TEXT[]      NOT NULL DEFAULT '{}',
  status         TEXT        NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS policies (
  id         TEXT        PRIMARY KEY,
  tenant_id  TEXT        NOT NULL,
  scope      TEXT        NOT NULL,
  rules      JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_limits (
  plan             TEXT    PRIMARY KEY,
  max_concurrency  INTEGER NOT NULL DEFAULT 5,
  max_steps        INTEGER NOT NULL DEFAULT 20,
  monthly_runs     INTEGER NOT NULL DEFAULT 100,
  retention_days   INTEGER NOT NULL DEFAULT 30,
  max_custom_tools INTEGER NOT NULL DEFAULT 10
);

INSERT INTO plan_limits (plan, max_concurrency, max_steps, monthly_runs, retention_days, max_custom_tools)
VALUES
  ('free',       2,   10,    50,   7,   3),
  ('starter',    5,   20,   500,  30,  10),
  ('growth',    20,   50, 5000,   90,  50),
  ('unlimited', 999, 999, 999999, 365, 999)
ON CONFLICT (plan) DO NOTHING;

-- 4. Data-plane tables
CREATE TABLE IF NOT EXISTS usage_ledger (
  id          TEXT          NOT NULL,
  tenant_id   TEXT          NOT NULL,
  workflow_id TEXT          NOT NULL,
  ts          TIMESTAMPTZ   NOT NULL,
  kind        TEXT          NOT NULL,
  qty         BIGINT        NOT NULL,
  cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, ts, id)
) PARTITION BY RANGE (ts);

CREATE TABLE IF NOT EXISTS usage_rollups_daily (
  tenant_id   TEXT          NOT NULL,
  day         DATE          NOT NULL,
  runs        INTEGER       NOT NULL DEFAULT 0,
  steps       INTEGER       NOT NULL DEFAULT 0,
  tokens_in   BIGINT        NOT NULL DEFAULT 0,
  tokens_out  BIGINT        NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  tool_errors INTEGER       NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT        PRIMARY KEY,
  tenant_id      TEXT        NOT NULL,
  workflow_id    TEXT        NOT NULL,
  step_seq       INTEGER     NOT NULL,
  context        JSONB       NOT NULL DEFAULT '{}',
  deadline       TIMESTAMPTZ NOT NULL,
  default_action TEXT        NOT NULL DEFAULT 'reject',
  decision       TEXT,
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS step_leases (
  workflow_id  TEXT        PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  worker_id    TEXT        NOT NULL,
  lease_until  TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Row-Level Security
ALTER TABLE workflows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots    ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE plan_limits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger        ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue           ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_leases         ENABLE ROW LEVEL SECURITY;

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
ALTER TABLE plan_limits      FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger        FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals           FORCE ROW LEVEL SECURITY;
ALTER TABLE job_queue           FORCE ROW LEVEL SECURITY;
ALTER TABLE step_leases         FORCE ROW LEVEL SECURITY;

-- Drop existing policies before creating (idempotency)
DO $$ DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename, policyname FROM pg_policies
           WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='plan_limits' AND policyname='plan_limits_readable') THEN
    DROP POLICY IF EXISTS plan_limits_readable ON plan_limits;
  END IF;
END $$;

CREATE POLICY tenant_isolation ON workflows    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON events       USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON snapshots    USING (tenant_id = current_setting('app.tenant_id', true));
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
CREATE POLICY plan_limits_readable ON plan_limits FOR SELECT USING (true);
CREATE POLICY tenant_isolation ON usage_ledger        USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON usage_rollups_daily USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON approvals           USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON job_queue           USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON step_leases         USING (tenant_id = current_setting('app.tenant_id', true));

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_job_queue_run_after
  ON job_queue (run_after) WHERE locked_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_queue_tenant_locked
  ON job_queue (tenant_id, locked_by);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_status_created
  ON workflows (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_pending
  ON approvals (tenant_id, deadline) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_ts
  ON usage_ledger (tenant_id, ts);

-- 7. tool_versions immutable trigger
CREATE OR REPLACE FUNCTION prevent_tool_version_modification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'tool_versions is immutable: % operations are not permitted. Create a new version row instead.', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS tool_versions_immutable ON tool_versions;
CREATE TRIGGER tool_versions_immutable
BEFORE UPDATE OR DELETE ON tool_versions
FOR EACH ROW EXECUTE FUNCTION prevent_tool_version_modification();

-- 8. Partition management
CREATE OR REPLACE FUNCTION create_usage_partitions(p_year INTEGER, p_month INTEGER)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  d         DATE;
  end_d     DATE;
  part_name TEXT;
  d_next    DATE;
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

SELECT create_usage_partitions(
  EXTRACT(YEAR  FROM CURRENT_DATE)::INTEGER,
  EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER
);

SELECT create_usage_partitions(
  EXTRACT(YEAR  FROM CURRENT_DATE + INTERVAL '1 month')::INTEGER,
  EXTRACT(MONTH FROM CURRENT_DATE + INTERVAL '1 month')::INTEGER
);

-- 9. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_rw;
`;

/**
 * Applies the multi-tenancy schema additions to the given pool.
 * The pool must already have the base schema applied (applySchema).
 * Intended for Testcontainers-based tests and dev bootstrapping.
 */
export async function applyMultiTenancy(pool: Pool): Promise<void> {
  await pool.query(MULTI_TENANCY_SQL);
}
