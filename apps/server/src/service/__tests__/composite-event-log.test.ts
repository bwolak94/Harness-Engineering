import type { HarnessEvent } from "@harness/contracts";
import { InMemoryEventLog } from "@harness/adapters-memory";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";
import { CompositeEventLog } from "../composite-event-log.js";

function makeEvent(workflowId: string, seq: number): HarnessEvent {
  return {
    id: `evt-${seq}`,
    workflowId,
    seq,
    at: new Date(0).toISOString(),
    type: "workflow.started",
    payload: {
      task: {
        id: workflowId,
        goal: "test",
        budget: {
          maxTokens: 1000,
          maxSteps: 5,
          maxWallClockMs: 5000,
          maxCostUsd: 1,
        },
      },
    },
  };
}

describe("CompositeEventLog", () => {
  it("appends to the inner log", async () => {
    const inner = new InMemoryEventLog();
    const bus = new EventBus();
    const log = new CompositeEventLog(inner, bus);
    const event = makeEvent("wf-1", 0);

    await log.append(event);

    const stored = await inner.read("wf-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(event);
  });

  it("publishes on the bus after appending", async () => {
    const inner = new InMemoryEventLog();
    const bus = new EventBus();
    const log = new CompositeEventLog(inner, bus);
    const published: HarnessEvent[] = [];
    bus.subscribe("wf-1", (e) => published.push(e));

    await log.append(makeEvent("wf-1", 0));

    expect(published).toHaveLength(1);
  });

  it("publishes AFTER the inner append resolves (durability first)", async () => {
    const order: string[] = [];
    const inner: import("@harness/core").EventLogPort = {
      async append(event) {
        order.push(`inner:${event.seq}`);
      },
      async read() {
        return [];
      },
    };
    const bus = new EventBus();
    const log = new CompositeEventLog(inner, bus);
    bus.subscribe("wf-1", (e) => order.push(`bus:${e.seq}`));

    await log.append(makeEvent("wf-1", 7));

    expect(order).toEqual(["inner:7", "bus:7"]);
  });

  it("delegates read to the inner log", async () => {
    const inner = new InMemoryEventLog();
    const bus = new EventBus();
    const log = new CompositeEventLog(inner, bus);

    await log.append(makeEvent("wf-1", 0));
    await log.append(makeEvent("wf-1", 1));
    await log.append(makeEvent("wf-1", 2));

    const from1 = await log.read("wf-1", 1);
    expect(from1.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("does not publish if inner append throws", async () => {
    const inner: import("@harness/core").EventLogPort = {
      async append() {
        throw new Error("disk full");
      },
      async read() {
        return [];
      },
    };
    const bus = new EventBus();
    const log = new CompositeEventLog(inner, bus);
    const published: HarnessEvent[] = [];
    bus.subscribe("wf-1", (e) => published.push(e));

    await expect(log.append(makeEvent("wf-1", 0))).rejects.toThrow("disk full");
    expect(published).toHaveLength(0);
  });
});
