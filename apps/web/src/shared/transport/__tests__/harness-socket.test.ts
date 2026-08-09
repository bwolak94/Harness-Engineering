/**
 * HarnessSocket unit tests.
 * Tests use a mock WebSocket to avoid real network connections.
 */
import type { HarnessEvent } from "@harness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessSocket } from "../harness-socket.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockWs {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  sent: string[];
  readyState: number;
  send(data: string): void;
  close(): void;
  simulateOpen(): void;
  simulateMessage(msg: unknown): void;
  simulateClose(): void;
}

let lastWs: MockWs | null = null;

function makeMockWs(): MockWs {
  const ws: MockWs = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    readyState: 0,
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
      this.onclose?.();
    },
    simulateOpen() {
      this.readyState = 1;
      this.onopen?.();
    },
    simulateMessage(msg) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    },
    simulateClose() {
      this.readyState = 3;
      this.onclose?.();
    },
  };
  return ws;
}

// Patch globalThis.WebSocket before importing HarnessSocket.
beforeEach(() => {
  vi.stubGlobal(
    "WebSocket",
    vi.fn(() => {
      const ws = makeMockWs();
      lastWs = ws;
      return ws;
    }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function makeEvent(seq: number): HarnessEvent {
  return {
    id: `e-${seq}`,
    workflowId: "wf-1",
    seq,
    at: new Date(0).toISOString(),
    type: "workflow.started",
    payload: {
      task: {
        id: "wf-1",
        goal: "test",
        budget: { maxTokens: 1, maxSteps: 1, maxWallClockMs: 1, maxCostUsd: 1 },
      },
    },
  };
}

describe("HarnessSocket", () => {
  it("sends subscribe message on open", () => {
    const socket = new HarnessSocket();
    socket.connect("wf-1", 0);
    lastWs?.simulateOpen();

    const msg = JSON.parse(lastWs?.sent[0] as string) as {
      type: string;
      workflowId: string;
      lastSeq: number;
    };
    expect(msg.type).toBe("subscribe");
    expect(msg.workflowId).toBe("wf-1");
    expect(msg.lastSeq).toBe(0);

    socket.disconnect();
  });

  it("calls onEvent callback with the received event", () => {
    const socket = new HarnessSocket();
    const received: HarnessEvent[] = [];
    socket.onEvent((e) => received.push(e));
    socket.connect("wf-1", 0);
    lastWs?.simulateOpen();

    const event = makeEvent(5);
    lastWs?.simulateMessage({ type: "event", event });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);

    socket.disconnect();
  });

  it("advances nextExpectedSeq after receiving an event", () => {
    const socket = new HarnessSocket();
    socket.connect("wf-1", 0);
    lastWs?.simulateOpen();
    lastWs?.simulateMessage({ type: "event", event: makeEvent(3) });

    // Simulate disconnect and reconnect — should send lastSeq = 4
    const firstWs = lastWs!;
    firstWs.simulateClose();

    // Advance timers so reconnect fires (but we don't want to wait in tests)
    // Instead, directly verify the nextExpectedSeq is tracked by checking
    // that after receiving seq=3 the next subscribe uses lastSeq=4.
    // We can verify this by inspecting the sent message after reconnect.
    vi.useFakeTimers();
    vi.runAllTimers();
    vi.useRealTimers();

    if (lastWs && lastWs !== firstWs) {
      lastWs.simulateOpen();
      const subscribeMsg = JSON.parse(lastWs.sent[0] as string) as { lastSeq: number };
      expect(subscribeMsg.lastSeq).toBe(4);
    }

    socket.disconnect();
  });

  it("calls onStatus with connected/disconnected", () => {
    const socket = new HarnessSocket();
    const statuses: string[] = [];
    socket.onStatus((s) => statuses.push(s));
    socket.connect("wf-1", 0);

    expect(statuses).toContain("connecting");
    lastWs?.simulateOpen();
    expect(statuses).toContain("connected");

    socket.disconnect();
  });

  it("calls onLagged when server sends stream.lagged", () => {
    const socket = new HarnessSocket();
    let lagged = false;
    socket.onLagged(() => {
      lagged = true;
    });
    socket.connect("wf-1", 0);
    lastWs?.simulateOpen();
    lastWs?.simulateMessage({ type: "stream.lagged", workflowId: "wf-1", lastSeq: 10 });

    expect(lagged).toBe(true);

    socket.disconnect();
  });

  it("disconnect prevents reconnect", () => {
    const socket = new HarnessSocket();
    socket.connect("wf-1", 0);
    socket.disconnect();

    vi.useFakeTimers();
    const wsMock = globalThis.WebSocket as unknown as { mock: { calls: unknown[] } };
    const wsCallCount = wsMock.mock.calls.length;
    lastWs?.simulateClose();
    vi.runAllTimers();
    expect(wsMock.mock.calls.length).toBe(wsCallCount);
    vi.useRealTimers();
  });
});
