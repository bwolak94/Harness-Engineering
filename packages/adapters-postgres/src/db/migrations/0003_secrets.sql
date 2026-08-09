-- ============================================================================
-- Migration 0003 — Secrets table and envelope encryption (T16)
--
-- Changes:
--   1. Add unique index on tenant_deks(tenant_id, version) for DEK lookup
--   2. secrets — per-tenant named secrets, encrypted with DEK
--   3. Row-Level Security on secrets table
-- Note: tenant_deks table was created in 0002_multi_tenancy.sql.
-- ============================================================================

-- ============================================================================
-- 1. Add unique constraint on tenant_deks for DEK versioning lookups
-- ============================================================================

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_deks_tenant_version
  ON tenant_deks (tenant_id, version);

-- ============================================================================
-- 2. Secrets table
-- ============================================================================

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS secrets (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  -- AES-256-GCM encrypted value: base64(iv[12] ++ authTag[16] ++ ciphertext)
  ciphertext  TEXT    NOT NULL,
  dek_version INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name),
  CONSTRAINT fk_secret_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_secrets_tenant_name ON secrets (tenant_id, name);

-- ============================================================================
-- 3. Row-Level Security
-- ============================================================================

--> statement-breakpoint
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;

--> statement-breakpoint
CREATE POLICY secrets_isolation ON secrets
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

-- ============================================================================
-- 4. Grant permissions to app_rw
-- ============================================================================

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON secrets TO app_rw;
