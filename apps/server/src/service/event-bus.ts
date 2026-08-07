import type { HarnessEvent } from "@harness/contracts";

// ---------------------------------------------------------------------------
// EventBus — in-process Observer (Pattern: Observer / Pub-Sub)
//
// The runtime publishes HarnessEvents without knowing who is listening.
// The WS gateway subscribes and fans out to connected clients.
// Additional subscribers (tracing, persistence) can be added here without
// touching the runtime — this is the point of Dependency Inversion.
// ---------------------------------------------------------------------------

export type EventHandler = (event: HarnessEvent) => void;

export interface EventBusPort {
  publish(event: HarnessEvent): void;
  subscribe(workflowId: string, handler: EventHandler): () => void;
}

export class EventBus implements EventBusPort {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  publish(event: HarnessEvent): void {
    const set = this.handlers.get(event.workflowId);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch {
        // Individual handler errors must not crash the publisher.
        // Each handler is responsible for its own error handling.
      }
    }
  }

  /**
   * Subscribe to events for a specific workflow.
   * Returns an unsubscribe function — always call it when the consumer is done.
   */
  subscribe(workflowId: string, handler: EventHandler): () => void {
    let set = this.handlers.get(workflowId);
    if (!set) {
      set = new Set();
      this.handlers.set(workflowId, set);
    }
    set.add(handler);

    return () => {
      const s = this.handlers.get(workflowId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(workflowId);
      }
    };
  }

  /** Number of active subscriptions (useful in tests). */
  get subscriptionCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }
}
