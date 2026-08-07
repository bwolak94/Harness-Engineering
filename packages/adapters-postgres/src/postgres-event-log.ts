import type { HarnessEvent } from "@harness/contracts";
import type { EventLogPort } from "@harness/core";
import { and, asc, eq, gte } from "drizzle-orm";
import type { HarnessDb } from "./db/client.js";
import { eventsTable } from "./db/schema.js";

/**
 * PostgresEventLog — durable, append-only implementation of EventLogPort.
 *
 * Pattern: Event Sourcing (append-only log)
 * - events table has UNIQUE(workflow_id, seq) and a trigger that rejects UPDATE/DELETE.
 * - append() uses ON CONFLICT DO NOTHING for idempotency: re-appending the same
 *   event (e.g. after a crash + resume) is safe.
 * - read() returns events in ascending seq order.
 */
export class PostgresEventLog implements EventLogPort {
  constructor(private readonly db: HarnessDb) {}

  async append(event: HarnessEvent): Promise<void> {
    await this.db
      .insert(eventsTable)
      .values({
        id: event.id,
        workflowId: event.workflowId,
        seq: event.seq,
        type: event.type,
        at: event.at,
        payload: event.payload as Record<string, unknown>,
      })
      .onConflictDoNothing();
  }

  async read(workflowId: string, fromSeq = 0): Promise<readonly HarnessEvent[]> {
    const rows = await this.db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.workflowId, workflowId), gte(eventsTable.seq, fromSeq)))
      .orderBy(asc(eventsTable.seq));

    return rows.map(
      (row) =>
        ({
          id: row.id,
          workflowId: row.workflowId,
          seq: row.seq,
          at: row.at,
          type: row.type,
          payload: row.payload,
        }) as HarnessEvent,
    );
  }
}
