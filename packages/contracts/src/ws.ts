import { z } from "zod";
import { HarnessEventSchema } from "./workflow.js";

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  workflowId: z.string().min(1),
  /** Resume point: server will replay all events with seq >= lastSeq. Defaults to 0. */
  lastSeq: z.number().int().nonnegative().default(0),
});

export const WsClientMessageSchema = z.discriminatedUnion("type", [SubscribeMessageSchema]);

export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export const WsEventMessageSchema = z.object({
  type: z.literal("event"),
  event: HarnessEventSchema,
});

/**
 * Sent to a slow consumer when its per-connection buffer overflows.
 * The client must re-fetch the full event list via GET /workflows/:id/events
 * starting from lastSeq + 1, then re-subscribe with that lastSeq.
 */
export const StreamLaggedMessageSchema = z.object({
  type: z.literal("stream.lagged"),
  workflowId: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
});

export const WsErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string(),
});

export const WsServerMessageSchema = z.discriminatedUnion("type", [
  WsEventMessageSchema,
  StreamLaggedMessageSchema,
  WsErrorMessageSchema,
]);

export type WsEventMessage = z.infer<typeof WsEventMessageSchema>;
export type StreamLaggedMessage = z.infer<typeof StreamLaggedMessageSchema>;
export type WsErrorMessage = z.infer<typeof WsErrorMessageSchema>;
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
