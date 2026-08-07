import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * workflows — one row per workflow, used for optimistic concurrency control.
 * The authoritative state is reconstructed from events + snapshots; this table
 * tracks only the version counter.
 */
export const workflowsTable = pgTable("workflows", {
  id: text("id").primaryKey(),
  /** Monotonically increasing version; incremented on every successful save(). */
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * events — append-only event log.
 * UNIQUE (workflow_id, seq) and the append-only trigger are enforced in the migration SQL.
 */
export const eventsTable = pgTable("events", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  /** ISO-8601 string preserved exactly as emitted by the runtime. */
  at: text("at").notNull(),
  /** Full HarnessEvent payload — strongly typed at the application layer. */
  payload: jsonb("payload").notNull(),
});

/**
 * snapshots — periodic state checkpoints (every SNAPSHOT_EVERY events).
 * Used by PostgresStateStore.load() to avoid replaying the full event log.
 */
export const snapshotsTable = pgTable("snapshots", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  /** seq of the last event included in this snapshot. */
  seq: integer("seq").notNull(),
  /** Serialised WorkflowState — reconstructed by PostgresStateStore.load(). */
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
