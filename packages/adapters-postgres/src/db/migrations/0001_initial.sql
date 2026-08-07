-- Harness event log — initial schema migration
-- Migration: 0001_initial
-- Description: Creates workflows, events, snapshots tables with append-only trigger.

CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT        PRIMARY KEY,
  version     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS events (
  id          TEXT        PRIMARY KEY,
  workflow_id TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  type        TEXT        NOT NULL,
  at          TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  CONSTRAINT events_workflow_seq_uniq UNIQUE (workflow_id, seq)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_workflow_seq ON events (workflow_id, seq);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS snapshots (
  id          TEXT        PRIMARY KEY,
  workflow_id TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  state       JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_snapshots_workflow_seq ON snapshots (workflow_id, seq DESC);

--> statement-breakpoint
-- Append-only enforcement for events table.
-- UPDATE and DELETE are rejected at the database level — not by application convention.
CREATE OR REPLACE FUNCTION prevent_event_modification()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events table is append-only: % operations are not permitted', TG_OP;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER events_immutable
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION prevent_event_modification();
