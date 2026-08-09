import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type HarnessDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * createDb — factory that wires a pg Pool into a Drizzle ORM instance.
 * Call once in the composition root; pass db into adapters.
 */
export function createDb(connectionString: string): { db: HarnessDb; pool: Pool } {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/**
 * SCHEMA_SQL — the full DDL for the Harness event log schema.
 *
 * Used by:
 *  - production: `pnpm db:migrate` via drizzle-kit (reads migrations folder)
 *  - tests: applied directly via pool.query() in Testcontainers setup
 *
 * Kept as a constant to avoid file-path resolution issues in both CJS and ESM
 * test environments.
 */
export const SCHEMA_SQL = /* sql */ `
-- Harness event log — initial schema

CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT        PRIMARY KEY,
  version     INTEGER     NOT NULL DEFAULT 0,
  status      TEXT        NOT NULL DEFAULT 'running',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT        PRIMARY KEY,
  workflow_id TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  type        TEXT        NOT NULL,
  at          TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  CONSTRAINT events_workflow_seq_uniq UNIQUE (workflow_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_workflow_seq ON events (workflow_id, seq);

CREATE TABLE IF NOT EXISTS snapshots (
  id          TEXT        PRIMARY KEY,
  workflow_id TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  state       JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_workflow_seq ON snapshots (workflow_id, seq DESC);

-- Append-only enforcement: UPDATE and DELETE on events are forbidden.
CREATE OR REPLACE FUNCTION prevent_event_modification()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events table is append-only: % operations are not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS events_immutable ON events;
CREATE TRIGGER events_immutable
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION prevent_event_modification();
`;

/**
 * applySchema — runs SCHEMA_SQL on the given pool.
 * Used in Testcontainers-based contract tests and dev bootstrapping.
 */
export async function applySchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
