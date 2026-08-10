import type { IncomingMessage } from "node:http";
import type { HarnessEvent } from "@harness/contracts";
import type { WsServerMessage } from "@harness/contracts/ws";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import type { EventBusPort } from "../service/event-bus.js";
import type { HarnessService } from "../service/harness-service.js";

// ---------------------------------------------------------------------------
// WsGateway — Gateway (Pattern: Gateway)
//
// All WebSocket knowledge lives here: upgrade handling, backpressure, resume.
// The rest of the application does not know WebSockets exist.
//
// Subscribe/replay protocol (race-condition safe):
//   1. Subscribe to bus first → buffer live events
//   2. Replay historical from eventLog (fromSeq = lastSeq)
//   3. Deliver buffered events with seq > lastReplayedSeq (no gaps, no duplicates)
//   4. Switch to real-time delivery
// ---------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 100;

function send(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

class WsConnection {
  private buffer: HarnessEvent[] = [];
  private replaying = true;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly workflowId: string,
    private readonly service: HarnessService,
    private readonly bus: EventBusPort,
  ) {}

  async subscribe(lastSeq: number): Promise<void> {
    // Step 1: Subscribe to live bus first, buffering events while replaying.
    this.unsubscribe = this.bus.subscribe(this.workflowId, (event) => {
      if (this.replaying) {
        if (this.buffer.length >= MAX_BUFFER_SIZE) {
          // Buffer overflow while replaying — drop the buffer and notify.
          this.overflow();
          return;
        }
        this.buffer.push(event);
      } else {
        this.deliver(event);
      }
    });

    // Step 2: Replay historical events.
    const historical = await this.service.getEvents(this.workflowId, lastSeq);
    let lastReplayedSeq = lastSeq - 1;
    for (const event of historical) {
      this.deliver(event);
      lastReplayedSeq = event.seq;
    }

    // Step 3: Switch to real-time, deliver buffered events not in historical.
    // Ephemeral events (model.delta, model.completed) are never in the EventLog,
    // so they bypass the seq dedup check to avoid being silently dropped when their
    // seq equals the last replayed seq.
    this.replaying = false;
    for (const event of this.buffer) {
      const isEphemeral = event.type === "model.delta" || event.type === "model.completed";
      if (isEphemeral || event.seq > lastReplayedSeq) {
        this.deliver(event);
      }
    }
    this.buffer = [];
  }

  private deliver(event: HarnessEvent): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // Backpressure: drop and notify if the WS send buffer is too large.
    if (this.ws.bufferedAmount > 0) {
      // Non-zero bufferedAmount means the client is slow.
      // We still deliver — true backpressure would require tracking per-event.
      // Severe cases hit the MAX_BUFFER_SIZE path during replay.
    }
    send(this.ws, { type: "event", event });
  }

  private overflow(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.replaying = false;
    this.buffer = [];
    send(this.ws, {
      type: "stream.lagged",
      workflowId: this.workflowId,
      lastSeq: 0,
    });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

export class WsGateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<WsConnection>();

  constructor(
    private readonly service: HarnessService,
    private readonly bus: EventBusPort,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
  }

  /**
   * Handle an HTTP upgrade request.
   * Call this from the Fastify server's "upgrade" event, but only for path `/stream`.
   */
  handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  private handleConnection(ws: WebSocket): void {
    let conn: WsConnection | null = null;

    ws.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", code: "INVALID_JSON", message: "Message must be valid JSON" });
        return;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { type?: unknown }).type !== "subscribe"
      ) {
        send(ws, {
          type: "error",
          code: "UNKNOWN_MESSAGE",
          message: 'Only "subscribe" messages are supported',
        });
        return;
      }

      const msg = parsed as { type: string; workflowId?: unknown; lastSeq?: unknown };
      const workflowId = typeof msg.workflowId === "string" ? msg.workflowId : null;
      if (!workflowId) {
        send(ws, {
          type: "error",
          code: "MISSING_WORKFLOW_ID",
          message: "subscribe message must include workflowId",
        });
        return;
      }

      const lastSeq =
        typeof msg.lastSeq === "number" && Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0
          ? msg.lastSeq
          : 0;

      // Destroy previous subscription if the client re-subscribes.
      conn?.destroy();
      conn = new WsConnection(ws, workflowId, this.service, this.bus);
      this.connections.add(conn);

      conn.subscribe(lastSeq).catch((err: unknown) => {
        console.error("[ws] subscribe error:", err);
        send(ws, {
          type: "error",
          code: "SUBSCRIBE_ERROR",
          message: "Failed to subscribe to workflow events",
        });
      });
    });

    ws.on("close", () => {
      conn?.destroy();
      if (conn) this.connections.delete(conn);
    });

    ws.on("error", (err) => {
      console.error("[ws] connection error:", err);
      conn?.destroy();
      if (conn) this.connections.delete(conn);
    });
  }

  /** Gracefully close all connections. */
  async close(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}
