import type { Socket } from "node:net";
import {
  FakeModelPort,
  FixedClock,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryToolRegistry,
  SeededIdPort,
} from "@harness/adapters-memory";
import type { WsServerMessage } from "@harness/contracts/ws";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { registerWorkflowRoutes } from "../http/workflow-routes.js";
import { CompositeEventLog } from "../service/composite-event-log.js";
import { EventBus } from "../service/event-bus.js";
import { HarnessService } from "../service/harness-service.js";
import { WsGateway } from "../ws/ws-gateway.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

interface TestApp {
  service: HarnessService;
  bus: EventBus;
  port: number;
  close: () => Promise<void>;
}

async function buildTestApp(model: FakeModelPort): Promise<TestApp> {
  const idPort = new SeededIdPort("wf");
  const clock = new FixedClock(0);
  const rawEventLog = new InMemoryEventLog();
  const stateStore = new InMemoryStateStore();
  const bus = new EventBus();
  const eventLog = new CompositeEventLog(rawEventLog, bus);
  const toolRegistry = new InMemoryToolRegistry();

  const service = new HarnessService({
    runtimeDeps: { model, eventLog, stateStore, toolRegistry, clock, idPort, middleware: [] },
    eventLog,
    stateStore,
    idPort,
  });

  const fastify = Fastify({ logger: false });
  registerWorkflowRoutes(fastify, service);
  const gateway = new WsGateway(service, bus);

  fastify.server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (url === "/stream" || url.startsWith("/stream?")) {
      gateway.handleUpgrade(req, socket as Socket, head);
    } else {
      socket.destroy();
    }
  });

  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const addr = fastify.server.address() as { port: number };

  return {
    service,
    bus,
    port: addr.port,
    close: async () => {
      await fastify.close();
      await gateway.close();
    },
  };
}

function wsConnect(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/stream`);
}

async function wsOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function wsReceive(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<WsServerMessage[]> {
  const messages: WsServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} messages, got ${messages.length}`));
    }, timeoutMs);

    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WsServerMessage;
      messages.push(msg);
      if (messages.length >= count) {
        clearTimeout(tid);
        resolve(messages);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WS gateway — subscribe and receive events", () => {
  it("delivers workflow events in real time", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("done")]);
    const app = await buildTestApp(model);
    const ws = wsConnect(app.port);
    await wsOpen(ws);

    const { workflowId } = app.service.start({ goal: "simple task" });

    ws.send(JSON.stringify({ type: "subscribe", workflowId, lastSeq: 0 }));

    // Expect at least: workflow.started + context.hydrated + workflow.completed (3 events minimum).
    // T09 adds a context.hydrated event before each model call, so there are now ≥3 events
    // even for a single-turn workflow.
    const msgs = await wsReceive(ws, 3, 3000);

    const types = msgs
      .filter((m): m is import("@harness/contracts/ws").WsEventMessage => m.type === "event")
      .map((m) => m.event.type);

    expect(types).toContain("workflow.started");
    expect(types).toContain("workflow.completed");

    ws.close();
    await app.close();
  });

  it("replays events on reconnect without gaps or duplicates", async () => {
    const model = new FakeModelPort([FakeModelPort.textResponse("done")]);
    const app = await buildTestApp(model);

    const { workflowId } = app.service.start({ goal: "reconnect test" });

    // Wait for the workflow to complete before connecting
    await new Promise<void>((resolve) => {
      const unsub = app.bus.subscribe(workflowId, (e) => {
        if (e.type === "workflow.completed" || e.type === "workflow.failed") {
          unsub();
          resolve();
        }
      });
    });

    // First client: subscribe from seq 0, read all events
    const ws1 = wsConnect(app.port);
    await wsOpen(ws1);
    ws1.send(JSON.stringify({ type: "subscribe", workflowId, lastSeq: 0 }));

    const historical = await app.service.getEvents(workflowId, 0);
    // Simulate a client that disconnects after receiving only 2 events.
    const msgs1 = await wsReceive(ws1, 2, 2000);
    ws1.close();

    const seqs1 = msgs1
      .filter((m): m is import("@harness/contracts/ws").WsEventMessage => m.type === "event")
      .map((m) => m.event.seq)
      .sort((a, b) => a - b);

    // Simulate disconnect after first 2 events; lastSeq is the NEXT expected seq
    // (i.e. resume from seq N means "I've seen 0..N-1, give me N onwards")
    const lastSeenSeq = seqs1[1] ?? 0;
    const resumeFromSeq = lastSeenSeq + 1;

    // Reconnect from resumeFromSeq
    const ws2 = wsConnect(app.port);
    await wsOpen(ws2);
    ws2.send(JSON.stringify({ type: "subscribe", workflowId, lastSeq: resumeFromSeq }));

    const remaining = historical.filter((e) => e.seq >= resumeFromSeq);
    if (remaining.length === 0) {
      // All events were already seen — nothing more to receive (workflow was very fast)
      ws2.close();
      await app.close();
      return;
    }
    const msgs2 = await wsReceive(ws2, remaining.length, 2000);
    ws2.close();

    const seqs2 = msgs2
      .filter((m): m is import("@harness/contracts/ws").WsEventMessage => m.type === "event")
      .map((m) => m.event.seq)
      .sort((a, b) => a - b);

    // No overlaps between first connection and second connection
    const set1 = new Set(seqs1);
    expect(seqs2.every((s) => !set1.has(s))).toBe(true);

    // Together they cover all historical events with no duplicates
    const allSeqs = seqs1.concat(seqs2).sort((a, b) => a - b);
    const expectedAllSeqs = historical.map((e) => e.seq).sort((a, b) => a - b);
    expect(allSeqs).toEqual(expectedAllSeqs);

    await app.close();
  });
});

describe("WS gateway — error handling", () => {
  it("sends error for invalid JSON", async () => {
    const model = new FakeModelPort([]);
    const app = await buildTestApp(model);
    const ws = wsConnect(app.port);
    await wsOpen(ws);

    const [msg] = await Promise.all([
      wsReceive(ws, 1, 1000),
      new Promise<void>((resolve) => {
        ws.send("not-json");
        setTimeout(resolve, 50);
      }),
    ]);

    expect(msg[0]).toMatchObject({ type: "error", code: "INVALID_JSON" });
    ws.close();
    await app.close();
  });

  it("sends error for missing workflowId", async () => {
    const model = new FakeModelPort([]);
    const app = await buildTestApp(model);
    const ws = wsConnect(app.port);
    await wsOpen(ws);

    ws.send(JSON.stringify({ type: "subscribe" }));
    const [msg] = await wsReceive(ws, 1, 1000);
    expect(msg).toMatchObject({ type: "error", code: "MISSING_WORKFLOW_ID" });

    ws.close();
    await app.close();
  });
});
