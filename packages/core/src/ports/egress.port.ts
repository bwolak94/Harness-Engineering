/**
 * EgressPort — safe outbound HTTP client.
 *
 * Pattern: Port (Hexagonal Architecture) + Ambassador / Egress Gateway
 * The concrete implementation (`EgressService` in `@harness/adapters-egress`)
 * enforces SSRF protection, DNS pinning, secret substitution, response-size
 * limiting, and the Claim Check pattern.
 *
 * Core and declarative tools depend only on this interface — they never
 * touch `node:https` or `node:dns` directly.
 */

import type { BlobRef } from "./blob-store.port.js";

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

export interface EgressRequest {
  method: string;
  /** URL may contain {{secrets.NAME}} placeholders. */
  url: string;
  /** Headers may contain {{secrets.NAME}} placeholders. */
  headers: Record<string, string>;
  body?: string;
  /**
   * Per-tool allowlist of allowed hostnames.
   * The EgressService rejects any request whose resolved host is not listed.
   * An empty array means no allowlist restriction.
   */
  allowedHosts: string[];
  tenantId: string;
  timeoutMs?: number;
  /** Maximum response body size in bytes before claim-check kicks in. */
  maxResponseBytes?: number;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  /**
   * Response body as a string. If a claim check was triggered, this contains
   * only the first 500 characters of the body as a preview.
   */
  body: string;
  /** Present when the full body was offloaded to the blob store. */
  claimCheck?: BlobRef;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface EgressPort {
  fetch(req: EgressRequest): Promise<EgressResponse>;
}

// ---------------------------------------------------------------------------
// Noop — always rejects; safe for tests that don't exercise egress
// ---------------------------------------------------------------------------

export class NoopEgressPort implements EgressPort {
  async fetch(_req: EgressRequest): Promise<EgressResponse> {
    throw new Error("NoopEgressPort: outbound requests are not enabled in this context");
  }
}
