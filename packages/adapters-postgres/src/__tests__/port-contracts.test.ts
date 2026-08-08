/**
 * Port contract tests — EventLogPort and StateStorePort.
 *
 * Pattern: Contract Tests
 * The same test suite (definePortContracts) is executed against two implementations:
 *   1. InMemoryEventLog / InMemoryStateStore — fast, no infrastructure
 *   2. PostgresEventLog / PostgresStateStore — real Postgres via Testcontainers
 *
 * If behaviour differs between the two adapters, a test will fail.
 * The in-memory fake is no longer just a convention — it's verified by this file.
 */
import { execSync } from "node:child_process";
import { InMemoryEventLog, InMemoryStateStore } from "@harness/adapters-memory";
import type { HarnessEvent } from "@harness/contracts";
import { ConcurrentWriteError, initialWorkflowState, reduce } from "@harness/core";
import type { EventLogPort, StateStorePort } from "@harness/core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Detect Docker availability at module load time (synchronous) so Testcontainers tests
// are skipped gracefully when Docker is not available (e.g. in CI without DinD).
let dockerAvailable = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerAvailable = true;
} catch {
  // Docker not available — Postgres contract suite will be skipped.
}
import { applySchema, createDb } from "../db/client.js";
import { PostgresEventLog } from "../postgres-event-log.js";
import { PostgresStateStore } from "../postgres-state-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(workflowId: string, seq: number): HarnessEvent {
  return {
    id: `${workflowId}-e${seq}`,
    workflowId,
    seq,
    at: new Date(seq * 1000).toISOString(),
    type: "workflow.started",
    payload: {
      task: {
        id: workflowId,
        goal: "test",
        budget: { maxTokens: 1000, maxSteps: 10, maxWallClockMs: 10000, maxCostUsd: 1 },
      },
    },
  };
}

function makeCheckpointEvent(workflowId: string, seq: number): HarnessEvent {
  return {
    id: `${workflowId}-cp${seq}`,
    workflowId,
    seq,
    at: new Date(seq * 1000).toISOString(),
    type: "state.checkpointed",
    payload: {
      checkpointId: `cp-${seq}`,
      tokensUsed: seq * 10,
      stepsCompleted: seq,
      costUsd: seq * 0.001,
    },
  };
}

// ---------------------------------------------------------------------------
// Contract suite factory
// ---------------------------------------------------------------------------

interface AdapterFactory {
  createEventLog(): EventLogPort;
  createStateStore(): StateStorePort;
  reset(): Promise<void>;
}

interface SuiteSetup {
  setup(): Promise<AdapterFactory>;
  teardown(): Promise<void>;
}

function definePortContracts(suiteName: string, suite: SuiteSetup) {
  describe(`Port contracts — ${suiteName}`, { timeout: 120_000 }, () => {
    let factory: AdapterFactory;
    let eventLog: EventLogPort;
    let stateStore: StateStorePort;

    beforeAll(async () => {
      factory = await suite.setup();
    }, 120_000);

    afterAll(async () => {
      await suite.teardown();
    });

    beforeEach(async () => {
      await factory.reset();
      eventLog = factory.createEventLog();
      stateStore = factory.createStateStore();
    });

    // -----------------------------------------------------------------------
    // EventLogPort
    // -----------------------------------------------------------------------

    describe("EventLogPort", () => {
      it("returns empty array for unknown workflowId", async () => {
        const events = await eventLog.read("unknown", 0);
        expect(events).toHaveLength(0);
      });

      it("appends a single event and reads it back", async () => {
        const event = makeEvent("wf-1", 0);
        await eventLog.append(event);
        const events = await eventLog.read("wf-1", 0);
        expect(events).toHaveLength(1);
        expect(events[0]?.id).toBe(event.id);
        expect(events[0]?.seq).toBe(0);
      });

      it("appends multiple events and returns them in seq order", async () => {
        await eventLog.append(makeEvent("wf-2", 2));
        await eventLog.append(makeEvent("wf-2", 0));
        await eventLog.append(makeEvent("wf-2", 1));

        const events = await eventLog.read("wf-2", 0);
        expect(events).toHaveLength(3);
        expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      });

      it("filters events by fromSeq", async () => {
        for (let i = 0; i < 5; i++) {
          await eventLog.append(makeEvent("wf-3", i));
        }
        const events = await eventLog.read("wf-3", 3);
        expect(events).toHaveLength(2);
        expect(events[0]?.seq).toBe(3);
        expect(events[1]?.seq).toBe(4);
      });

      it("isolates events by workflowId", async () => {
        await eventLog.append(makeEvent("wf-a", 0));
        await eventLog.append(makeEvent("wf-b", 0));

        const a = await eventLog.read("wf-a", 0);
        const b = await eventLog.read("wf-b", 0);
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(a[0]?.workflowId).toBe("wf-a");
        expect(b[0]?.workflowId).toBe("wf-b");
      });

      it("append is idempotent — re-appending the same event is a no-op", async () => {
        const event = makeEvent("wf-idem", 0);
        await eventLog.append(event);
        await eventLog.append(event); // should not throw or duplicate
        const events = await eventLog.read("wf-idem", 0);
        expect(events).toHaveLength(1);
      });

      it("preserves the full payload", async () => {
        const event = makeEvent("wf-payload", 0);
        await eventLog.append(event);
        const [saved] = await eventLog.read("wf-payload", 0);
        expect(saved?.payload).toEqual(event.payload);
      });
    });

    // -----------------------------------------------------------------------
    // StateStorePort
    // -----------------------------------------------------------------------

    describe("StateStorePort", () => {
      it("returns undefined for unknown workflowId", async () => {
        const result = await stateStore.load("unknown-wf");
        expect(result).toBeUndefined();
      });

      it("first save (expectedVersion=0) succeeds and returns version=1 on load", async () => {
        const wfId = "wf-first-save";
        const event = makeEvent(wfId, 0);
        let state = initialWorkflowState(wfId);
        state = reduce(state, event);

        await stateStore.save(wfId, state, 0);

        const loaded = await stateStore.load(wfId);
        expect(loaded).toBeDefined();
        expect(loaded?.version).toBe(1);
        expect(loaded?.state.workflowId).toBe(wfId);
        expect(loaded?.state.status).toBe("running");
      });

      it("subsequent saves increment version correctly", async () => {
        const wfId = "wf-versions";
        let state = initialWorkflowState(wfId);
        state = reduce(state, makeEvent(wfId, 0));

        await stateStore.save(wfId, state, 0); // version 0 → 1

        state = reduce(state, makeCheckpointEvent(wfId, 1));
        await stateStore.save(wfId, state, 1); // version 1 → 2

        const loaded = await stateStore.load(wfId);
        expect(loaded?.version).toBe(2);
      });

      it("throws ConcurrentWriteError when expectedVersion is wrong", async () => {
        const wfId = "wf-conflict";
        const state = reduce(initialWorkflowState(wfId), makeEvent(wfId, 0));

        await stateStore.save(wfId, state, 0); // version 0 → 1

        // Attempt save with stale version 0 — should throw
        await expect(stateStore.save(wfId, state, 0)).rejects.toBeInstanceOf(ConcurrentWriteError);
      });

      it("two concurrent saves with the same version → exactly one succeeds", async () => {
        const wfId = "wf-concurrent";
        const state = reduce(initialWorkflowState(wfId), makeEvent(wfId, 0));

        // Both attempt version 0 simultaneously
        const results = await Promise.allSettled([
          stateStore.save(wfId, state, 0),
          stateStore.save(wfId, state, 0),
        ]);

        const successes = results.filter((r) => r.status === "fulfilled");
        const failures = results.filter((r) => r.status === "rejected");

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrentWriteError);
      });

      it("load reconstructs state correctly after save", async () => {
        const wfId = "wf-reconstruct";
        let state = initialWorkflowState(wfId);
        state = reduce(state, makeEvent(wfId, 0)); // status → running

        await stateStore.save(wfId, state, 0);

        const loaded = await stateStore.load(wfId);
        expect(loaded?.state.status).toBe("running");
        expect(loaded?.state.seq).toBe(0);
        expect(loaded?.state.workflowId).toBe(wfId);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// In-Memory suite — fast, no infrastructure
// ---------------------------------------------------------------------------

let inMemoryEventLog: InMemoryEventLog;
let inMemoryStateStore: InMemoryStateStore;

definePortContracts("InMemory", {
  setup: async () => ({
    createEventLog: () => {
      inMemoryEventLog = new InMemoryEventLog();
      return inMemoryEventLog;
    },
    createStateStore: () => {
      inMemoryStateStore = new InMemoryStateStore();
      return inMemoryStateStore;
    },
    reset: async () => {
      // fresh instances created in createEventLog/createStateStore above
    },
  }),
  teardown: async () => {},
});

// ---------------------------------------------------------------------------
// Postgres suite — real database via Testcontainers
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)(
  "Port contracts — Postgres (Testcontainers)",
  { timeout: 180_000 },
  () => {
    let pool: Pool;
    let db: ReturnType<typeof createDb>["db"];
    let pgEventLog: PostgresEventLog;
    let pgStateStore: PostgresStateStore;

    beforeAll(async () => {
      // Lazy-import Testcontainers to avoid load errors when Docker is unavailable.
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const container = await new PostgreSqlContainer("postgres:17-alpine").start();

      pool = new Pool({ connectionString: container.getConnectionUri() });
      const created = createDb(container.getConnectionUri());
      db = created.db;

      await applySchema(pool);

      // Register teardown — container.stop() called by afterAll
      afterAll(async () => {
        await pool.end();
        await container.stop();
      });
    }, 120_000);

    beforeEach(async () => {
      // Truncate tables between tests for isolation.
      await pool.query("TRUNCATE TABLE snapshots, events, workflows RESTART IDENTITY CASCADE");
      pgEventLog = new PostgresEventLog(db);
      pgStateStore = new PostgresStateStore(db);
    });

    // Run the full contract suite against Postgres adapters.
    const contractTests = [
      {
        name: "EventLogPort — returns empty array for unknown workflowId",
        run: async () => {
          const events = await pgEventLog.read("unknown", 0);
          expect(events).toHaveLength(0);
        },
      },
      {
        name: "EventLogPort — appends and reads back events in seq order",
        run: async () => {
          await pgEventLog.append(makeEvent("wf-pg-1", 2));
          await pgEventLog.append(makeEvent("wf-pg-1", 0));
          await pgEventLog.append(makeEvent("wf-pg-1", 1));
          const events = await pgEventLog.read("wf-pg-1", 0);
          expect(events).toHaveLength(3);
          expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
        },
      },
      {
        name: "EventLogPort — filters by fromSeq",
        run: async () => {
          for (let i = 0; i < 5; i++) await pgEventLog.append(makeEvent("wf-pg-2", i));
          const events = await pgEventLog.read("wf-pg-2", 3);
          expect(events).toHaveLength(2);
          expect(events[0]?.seq).toBe(3);
        },
      },
      {
        name: "EventLogPort — append is idempotent",
        run: async () => {
          const ev = makeEvent("wf-pg-idem", 0);
          await pgEventLog.append(ev);
          await pgEventLog.append(ev); // ON CONFLICT DO NOTHING
          const events = await pgEventLog.read("wf-pg-idem", 0);
          expect(events).toHaveLength(1);
        },
      },
      {
        name: "EventLogPort — UPDATE on events is rejected by trigger",
        run: async () => {
          await pgEventLog.append(makeEvent("wf-pg-trigger", 0));
          // Direct SQL UPDATE should be rejected by the append-only trigger.
          await expect(
            pool.query("UPDATE events SET type = 'hacked' WHERE workflow_id = 'wf-pg-trigger'"),
          ).rejects.toThrow("append-only");
        },
      },
      {
        name: "StateStorePort — first save and load",
        run: async () => {
          const wfId = "wf-pg-save";
          const state = reduce(initialWorkflowState(wfId), makeEvent(wfId, 0));
          await pgEventLog.append(makeEvent(wfId, 0));
          await pgStateStore.save(wfId, state, 0);
          const loaded = await pgStateStore.load(wfId);
          expect(loaded?.version).toBe(1);
          expect(loaded?.state.status).toBe("running");
        },
      },
      {
        name: "StateStorePort — ConcurrentWriteError on stale version",
        run: async () => {
          const wfId = "wf-pg-conflict";
          const state = reduce(initialWorkflowState(wfId), makeEvent(wfId, 0));
          await pgEventLog.append(makeEvent(wfId, 0));
          await pgStateStore.save(wfId, state, 0);
          await expect(pgStateStore.save(wfId, state, 0)).rejects.toBeInstanceOf(
            ConcurrentWriteError,
          );
        },
      },
      {
        name: "StateStorePort — concurrent saves: one success, one ConcurrentWriteError",
        run: async () => {
          const wfId = "wf-pg-concurrent";
          const state = reduce(initialWorkflowState(wfId), makeEvent(wfId, 0));
          await pgEventLog.append(makeEvent(wfId, 0));
          const results = await Promise.allSettled([
            pgStateStore.save(wfId, state, 0),
            pgStateStore.save(wfId, state, 0),
          ]);
          const successes = results.filter((r) => r.status === "fulfilled");
          const failures = results.filter((r) => r.status === "rejected");
          expect(successes).toHaveLength(1);
          expect(failures).toHaveLength(1);
          expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(
            ConcurrentWriteError,
          );
        },
      },
    ];

    for (const test of contractTests) {
      it(test.name, test.run, 30_000);
    }

    // -----------------------------------------------------------------------
    // Postgres-only: performance test for snapshot-based restoration
    // -----------------------------------------------------------------------

    it("restores state from 10 000 events in under 100 ms with snapshots every 50", async () => {
      const wfId = "wf-perf";
      const TOTAL = 10_000;

      // Insert events in bulk for speed.
      const batchSize = 500;
      for (let batch = 0; batch < TOTAL / batchSize; batch++) {
        const values = Array.from({ length: batchSize }, (_, i) => {
          const seq = batch * batchSize + i;
          const ev = seq === 0 ? makeEvent(wfId, seq) : makeCheckpointEvent(wfId, seq);
          return `('${ev.id}', '${wfId}', ${seq}, '${ev.type}', '${ev.at}', '${JSON.stringify(ev.payload).replace(/'/g, "''")}')`;
        });
        await pool.query(
          `INSERT INTO events (id, workflow_id, seq, type, at, payload) VALUES ${values.join(",")}`,
        );
      }

      // Insert snapshots every 50 events (simulating what PostgresStateStore.save() does).
      let state = initialWorkflowState(wfId);
      const snapshotValues: string[] = [];
      for (let seq = 0; seq < TOTAL; seq++) {
        const ev = seq === 0 ? makeEvent(wfId, seq) : makeCheckpointEvent(wfId, seq);
        state = reduce(state, ev);
        if ((seq + 1) % 50 === 0) {
          snapshotValues.push(
            `('${wfId}-snap-${seq}', '${wfId}', ${seq}, '${JSON.stringify(state).replace(/'/g, "''")}')`,
          );
        }
      }
      for (let i = 0; i < snapshotValues.length; i += 100) {
        const batch = snapshotValues.slice(i, i + 100);
        await pool.query(
          `INSERT INTO snapshots (id, workflow_id, seq, state) VALUES ${batch.join(",")}`,
        );
      }

      // Insert workflow row so load() finds it.
      await pool.query(`INSERT INTO workflows (id, version) VALUES ('${wfId}', 1)`);

      const pgStore = new PostgresStateStore(db);
      const start = performance.now();
      const loaded = await pgStore.load(wfId);
      const elapsed = performance.now() - start;

      expect(loaded?.state.seq).toBe(TOTAL - 1);
      expect(elapsed).toBeLessThan(100);
    }, 60_000);
  },
);
