import type { HarnessEvent } from "@harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";

function makeEvent(workflowId: string, seq = 0): HarnessEvent {
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

describe("EventBus", () => {
  it("delivers published events to subscribers of the same workflowId", () => {
    const bus = new EventBus();
    const received: HarnessEvent[] = [];
    bus.subscribe("wf-1", (e) => received.push(e));

    const event = makeEvent("wf-1");
    bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it("does not deliver events to subscribers of a different workflowId", () => {
    const bus = new EventBus();
    const received: HarnessEvent[] = [];
    bus.subscribe("wf-2", (e) => received.push(e));

    bus.publish(makeEvent("wf-1"));

    expect(received).toHaveLength(0);
  });

  it("delivers to multiple subscribers of the same workflowId", () => {
    const bus = new EventBus();
    const a: HarnessEvent[] = [];
    const b: HarnessEvent[] = [];
    bus.subscribe("wf-1", (e) => a.push(e));
    bus.subscribe("wf-1", (e) => b.push(e));

    bus.publish(makeEvent("wf-1"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const received: HarnessEvent[] = [];
    const unsub = bus.subscribe("wf-1", (e) => received.push(e));

    bus.publish(makeEvent("wf-1", 0));
    unsub();
    bus.publish(makeEvent("wf-1", 1));

    expect(received).toHaveLength(1);
  });

  it("unsubscribe removes the entry when no subscribers remain", () => {
    const bus = new EventBus();
    const unsub = bus.subscribe("wf-1", () => {});
    expect(bus.subscriptionCount).toBe(1);
    unsub();
    expect(bus.subscriptionCount).toBe(0);
  });

  it("handler error does not crash the publisher", () => {
    const bus = new EventBus();
    const good: HarnessEvent[] = [];
    bus.subscribe("wf-1", () => {
      throw new Error("boom");
    });
    bus.subscribe("wf-1", (e) => good.push(e));

    expect(() => bus.publish(makeEvent("wf-1"))).not.toThrow();
    expect(good).toHaveLength(1);
  });

  it("publish with no subscribers is a no-op", () => {
    const bus = new EventBus();
    expect(() => bus.publish(makeEvent("wf-x"))).not.toThrow();
  });

  it("subscriptionCount reflects active subscriptions", () => {
    const bus = new EventBus();
    expect(bus.subscriptionCount).toBe(0);
    const u1 = bus.subscribe("wf-1", vi.fn());
    const u2 = bus.subscribe("wf-1", vi.fn());
    expect(bus.subscriptionCount).toBe(2);
    u1();
    expect(bus.subscriptionCount).toBe(1);
    u2();
    expect(bus.subscriptionCount).toBe(0);
  });
});
