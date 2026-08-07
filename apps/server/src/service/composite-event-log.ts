import type { HarnessEvent } from "@harness/contracts";
import type { EventLogPort } from "@harness/core";
import type { EventBusPort } from "./event-bus.js";

// ---------------------------------------------------------------------------
// CompositeEventLog — fan-out adapter (Pattern: Decorator / Composite)
//
// Writes each event to the durable log AND publishes it on the in-process bus.
// The runtime only knows about EventLogPort — adding real-time delivery here
// requires zero changes in HarnessRuntime. That is the test of hexagonal design.
// ---------------------------------------------------------------------------

export class CompositeEventLog implements EventLogPort {
  constructor(
    private readonly inner: EventLogPort,
    private readonly bus: EventBusPort,
  ) {}

  async append(event: HarnessEvent): Promise<void> {
    await this.inner.append(event);
    // Publish after successful persistence so observers see only durable events.
    this.bus.publish(event);
  }

  read(workflowId: string, fromSeq?: number): Promise<readonly HarnessEvent[]> {
    return this.inner.read(workflowId, fromSeq);
  }
}
