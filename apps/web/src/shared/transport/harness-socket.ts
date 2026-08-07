import type { HarnessEvent } from "@harness/contracts";
import { wsStreamUrl } from "../config.js";

// ---------------------------------------------------------------------------
// HarnessSocket — WebSocket client with auto-reconnect and resume (T05)
//
// Pattern: Adapter (transport)
// This is the ONLY place in the application that knows about WebSockets.
// Swapping to SSE or long-polling touches only this file.
//
// Resume protocol:
//   On reconnect, sends { type: "subscribe", workflowId, lastSeq } where
//   lastSeq = next expected seq (= last received seq + 1).
//   Server replays from lastSeq, guaranteeing no gaps and no duplicates.
// ---------------------------------------------------------------------------

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

type EventHandler = (event: HarnessEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type LaggedHandler = (lastSeq: number) => void;

export class HarnessSocket {
  private ws: WebSocket | null = null;
  private workflowId: string | null = null;
  // nextExpectedSeq: the seq we want the server to start from on (re)connect.
  // Updated to event.seq + 1 after each received event.
  private nextExpectedSeq = 0;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private onEventCb: EventHandler | null = null;
  private onStatusCb: StatusHandler | null = null;
  private onLaggedCb: LaggedHandler | null = null;

  /** Subscribe to events from a workflow, resuming from nextSeq if > 0. */
  connect(workflowId: string, nextSeq = 0): void {
    this.workflowId = workflowId;
    this.nextExpectedSeq = nextSeq;
    this.reconnectDelay = 500;
    this.destroyed = false;
    this.open();
  }

  /** Stop receiving and disable reconnects. */
  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  onEvent(cb: EventHandler): void {
    this.onEventCb = cb;
  }

  onStatus(cb: StatusHandler): void {
    this.onStatusCb = cb;
  }

  onLagged(cb: LaggedHandler): void {
    this.onLaggedCb = cb;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private open(): void {
    if (this.destroyed) return;
    this.onStatusCb?.("connecting");

    const ws = new WebSocket(wsStreamUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.destroyed) {
        ws.close();
        return;
      }
      this.reconnectDelay = 500;
      this.onStatusCb?.("connected");
      ws.send(
        JSON.stringify({
          type: "subscribe",
          workflowId: this.workflowId,
          lastSeq: this.nextExpectedSeq,
        }),
      );
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as { type: string; event?: HarnessEvent; lastSeq?: number };

      if (msg.type === "event" && msg.event) {
        // Advance resume pointer so reconnect won't re-deliver this event.
        this.nextExpectedSeq = msg.event.seq + 1;
        this.onEventCb?.(msg.event);
      } else if (msg.type === "stream.lagged") {
        // Server buffer overflowed — reset to seq 0 so the client re-fetches all.
        this.nextExpectedSeq = 0;
        this.onLaggedCb?.(msg.lastSeq ?? 0);
        // Reconnect immediately with a full replay.
        ws.close();
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.onStatusCb?.("disconnected");
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose follows every onerror, so reconnect is handled there.
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectDelay);
    // Exponential backoff capped at 10 s.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }
}
