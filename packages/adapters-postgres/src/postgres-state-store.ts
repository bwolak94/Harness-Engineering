import type { HarnessEvent } from "@harness/contracts";
import { ConcurrentWriteError, initialWorkflowState, reduce } from "@harness/core";
import type { StateStorePort, VersionedState, WorkflowState } from "@harness/core";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { HarnessDb } from "./db/client.js";
import { eventsTable, snapshotsTable, workflowsTable } from "./db/schema.js";

/**
 * How many events trigger a new snapshot.
 * Load cost = replay at most (SNAPSHOT_EVERY - 1) events after the latest snapshot.
 */
const SNAPSHOT_EVERY = 50;

/**
 * PostgresStateStore — StateStorePort backed by PostgreSQL.
 *
 * Patterns: Event Sourcing + Snapshot, Optimistic Locking, Repository
 *
 * load(): latest snapshot + events since that snapshot → replay via reduce() →
 *         current state. O(SNAPSHOT_EVERY) events at most, never O(total events).
 *
 * save(): UPDATE workflows WHERE version = expectedVersion (optimistic lock).
 *         Zero rows updated = concurrent writer won = ConcurrentWriteError.
 *         On first save (expectedVersion = 0): INSERT instead of UPDATE.
 *         Snapshot written when (state.seq + 1) % SNAPSHOT_EVERY === 0.
 */
export class PostgresStateStore implements StateStorePort {
  constructor(private readonly db: HarnessDb) {}

  async load(workflowId: string): Promise<VersionedState | undefined> {
    const wfRows = await this.db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, workflowId))
      .limit(1);

    if (wfRows.length === 0) return undefined;
    const { version } = wfRows[0]!;

    // Find the latest snapshot for fast replay start.
    const snapRows = await this.db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.workflowId, workflowId))
      .orderBy(desc(snapshotsTable.seq))
      .limit(1);

    let state: WorkflowState;
    let fromSeq: number;

    if (snapRows.length > 0) {
      // Restore from snapshot — replay only the delta.
      state = snapRows[0]!.state as unknown as WorkflowState;
      fromSeq = snapRows[0]!.seq + 1;
    } else {
      // No snapshot yet — replay from the beginning.
      state = initialWorkflowState(workflowId);
      fromSeq = 0;
    }

    // Replay events after the snapshot through the isomorphic reducer.
    const eventRows = await this.db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.workflowId, workflowId), gte(eventsTable.seq, fromSeq)))
      .orderBy(asc(eventsTable.seq));

    for (const row of eventRows) {
      state = reduce(state, row.payload as unknown as HarnessEvent);
    }

    return { state, version };
  }

  async save(workflowId: string, state: WorkflowState, expectedVersion: number): Promise<void> {
    const now = new Date();

    await this.db.transaction(async (tx) => {
      if (expectedVersion === 0) {
        // First save — INSERT. Duplicate-key violation means a concurrent writer was first.
        try {
          await tx.insert(workflowsTable).values({
            id: workflowId,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
        } catch {
          // Another process inserted the workflow concurrently.
          const existing = await tx
            .select({ version: workflowsTable.version })
            .from(workflowsTable)
            .where(eq(workflowsTable.id, workflowId))
            .limit(1);
          const actual = existing[0]?.version ?? 0;
          throw new ConcurrentWriteError(workflowId, expectedVersion, actual);
        }
      } else {
        // Subsequent saves — optimistic UPDATE.
        const result = await tx
          .update(workflowsTable)
          .set({ version: expectedVersion + 1, updatedAt: now })
          .where(and(eq(workflowsTable.id, workflowId), eq(workflowsTable.version, expectedVersion)));

        if ((result.rowCount ?? 0) === 0) {
          // No rows updated — version mismatch (concurrent write or workflow deleted).
          const existing = await tx
            .select({ version: workflowsTable.version })
            .from(workflowsTable)
            .where(eq(workflowsTable.id, workflowId))
            .limit(1);
          const actual = existing[0]?.version ?? 0;
          throw new ConcurrentWriteError(workflowId, expectedVersion, actual);
        }
      }

      // Snapshot every SNAPSHOT_EVERY events for fast future loads.
      if (state.seq >= 0 && (state.seq + 1) % SNAPSHOT_EVERY === 0) {
        await tx
          .insert(snapshotsTable)
          .values({
            id: `${workflowId}-snap-${state.seq}`,
            workflowId,
            seq: state.seq,
            state: state as unknown as Record<string, unknown>,
            createdAt: now,
          })
          .onConflictDoNothing();
      }
    });
  }
}
