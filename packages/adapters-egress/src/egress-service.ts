/**
 * EgressService — concrete EgressPort implementation.
 *
 * Enforces, in order:
 *  1. Allowlist check (hostname must be in spec.allowedHosts if allowedHosts non-empty)
 *  2. Static SSRF guard on hostname
 *  3. DNS resolution via injected lookup (testable without monkey-patching)
 *  4. Dynamic SSRF guard on resolved IP (blocks DNS-rebinding attacks)
 *  5. Secret substitution ({{secrets.NAME}} → plaintext, never logged)
 *  6. HTTPS request via custom Agent that pins the connection to the resolved IP
 *  7. Response-size check + Claim Check for bodies > threshold
 *
 * Pattern: Ambassador / Egress Gateway
 * All outbound HTTP in the harness goes through this class.
 */

import { lookup as defaultDnsLookup } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import type { BlobStorePort } from "@harness/core";
import type { EgressPort, EgressRequest, EgressResponse } from "@harness/core";
import type { SecretPort } from "@harness/core";
import { isBlockedHostname, isPrivateIp } from "./ssrf-guard.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard limit
const CLAIM_CHECK_THRESHOLD_BYTES = 256 * 1024; // 256 kB
const CLAIM_CHECK_PREVIEW_CHARS = 500;
const CLAIM_CHECK_BUCKET = "claim-checks";

// ---------------------------------------------------------------------------
// Secret substitution helper
// ---------------------------------------------------------------------------

const SECRET_PLACEHOLDER = /\{\{secrets\.([A-Za-z0-9_.-]+)\}\}/g;

async function substituteSecrets(
  text: string,
  tenantId: string,
  secrets: SecretPort,
): Promise<string> {
  const matches = [...text.matchAll(SECRET_PLACEHOLDER)];
  if (matches.length === 0) return text;

  let result = text;
  // Resolve each unique name once
  const cache = new Map<string, string>();
  for (const [_placeholder, name] of matches) {
    if (!name || cache.has(name)) continue;
    const value = await secrets.resolve(tenantId, name);
    if (value === null) {
      throw new Error(`Secret '${name}' not found for tenant '${tenantId}'`);
    }
    cache.set(name, value);
  }

  for (const [placeholder, name] of matches) {
    if (!name) continue;
    const value = cache.get(name);
    if (value !== undefined) {
      result = result.split(placeholder).join(value);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// EgressService
// ---------------------------------------------------------------------------

export interface EgressServiceOptions {
  /** Override the DNS lookup function for testing. */
  dnsLookup?: LookupFunction;
  /** Bytes above which a response is claim-checked. Default: 256 kB. */
  claimCheckThresholdBytes?: number;
}

export class EgressService implements EgressPort {
  private readonly secrets: SecretPort;
  private readonly blobStore: BlobStorePort;
  private readonly lookup: LookupFunction;
  private readonly claimCheckThreshold: number;

  constructor(secrets: SecretPort, blobStore: BlobStorePort, opts: EgressServiceOptions = {}) {
    this.secrets = secrets;
    this.blobStore = blobStore;
    this.lookup = opts.dnsLookup ?? defaultDnsLookup;
    this.claimCheckThreshold = opts.claimCheckThresholdBytes ?? CLAIM_CHECK_THRESHOLD_BYTES;
  }

  async fetch(req: EgressRequest): Promise<EgressResponse> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = req.maxResponseBytes ?? DEFAULT_MAX_BYTES;

    // 1. Substitute secrets BEFORE parsing the URL so we get the real hostname
    const resolvedUrl = await substituteSecrets(req.url, req.tenantId, this.secrets);
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      resolvedHeaders[k] = await substituteSecrets(v, req.tenantId, this.secrets);
    }
    const resolvedBody = req.body
      ? await substituteSecrets(req.body, req.tenantId, this.secrets)
      : undefined;

    // 2. Parse URL
    let parsed: URL;
    try {
      parsed = new URL(resolvedUrl);
    } catch {
      throw new Error(`EgressService: malformed URL '${req.url}'`);
    }

    const hostname = parsed.hostname;

    // 3. Static hostname check (catches literal IPs and well-known metadata hosts)
    if (isBlockedHostname(hostname)) {
      throw new Error(
        `EgressService: URL hostname '${hostname}' is a blocked address (RFC1918/link-local/metadata)`,
      );
    }

    // 4. Allowlist check
    if (req.allowedHosts.length > 0 && !req.allowedHosts.includes(hostname)) {
      throw new Error(
        `EgressService: hostname '${hostname}' is not in the tool's allowedHosts list`,
      );
    }

    // 5. DNS resolution + dynamic SSRF check
    const resolvedIp = await this.resolve(hostname);

    // 6. Perform request with IP-pinned agent
    const responseRaw = await this.request(
      req.method,
      parsed,
      resolvedIp,
      resolvedHeaders,
      resolvedBody,
      timeoutMs,
      maxBytes,
    );

    // 7. Claim check
    if (responseRaw.bodyBuffer.length > this.claimCheckThreshold) {
      const key = `${req.tenantId}/${Date.now()}-egress-claim`;
      const ref = await this.blobStore.put(
        CLAIM_CHECK_BUCKET,
        key,
        responseRaw.bodyBuffer,
        responseRaw.contentType,
      );
      const preview = responseRaw.bodyBuffer
        .toString("utf8", 0, CLAIM_CHECK_PREVIEW_CHARS * 4)
        .slice(0, CLAIM_CHECK_PREVIEW_CHARS);
      return {
        status: responseRaw.status,
        headers: responseRaw.headers,
        body: `${preview}\n[CLAIM CHECK: ${ref.sizeBytes} bytes stored at ${ref.key}]`,
        claimCheck: ref,
      };
    }

    return {
      status: responseRaw.status,
      headers: responseRaw.headers,
      body: responseRaw.bodyBuffer.toString("utf8"),
    };
  }

  // ---------------------------------------------------------------------------
  // DNS resolution with SSRF check
  // ---------------------------------------------------------------------------

  private resolve(hostname: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.lookup(hostname, { family: 4 }, (err, address) => {
        if (err) return reject(new Error(`DNS lookup failed for '${hostname}': ${err.message}`));
        // With family:4 and no all:true, address is always a single string.
        // The LookupFunction type is a union — narrow it here.
        const ip = Array.isArray(address) ? (address[0]?.address ?? "") : (address as string);
        if (!ip) return reject(new Error(`DNS lookup returned no address for '${hostname}'`));
        if (isPrivateIp(ip)) {
          return reject(
            new Error(
              `EgressService: DNS resolved '${hostname}' to blocked IP '${ip}' (RFC1918/link-local)`,
            ),
          );
        }
        resolve(ip);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP request with IP-pinned agent
  // ---------------------------------------------------------------------------

  private request(
    method: string,
    url: URL,
    resolvedIp: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    bodyBuffer: Buffer;
    contentType: string;
  }> {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === "https:";
      const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

      // Pin connection to the resolved IP while presenting the original hostname
      // for TLS SNI and HTTP Host header — prevents TOCTOU DNS rebinding.
      const AgentClass = isHttps ? https.Agent : http.Agent;
      const pinnedAgent = new AgentClass({
        lookup: (_h, _opts, cb) => cb(null, resolvedIp, 4),
      });

      const reqHeaders: Record<string, string> = {
        Host: url.host,
        ...headers,
      };
      if (body !== undefined) {
        reqHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
        reqHeaders["Content-Type"] ??= "application/json";
      }

      const options = {
        hostname: resolvedIp,
        port,
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers: reqHeaders,
        agent: pinnedAgent,
        timeout: timeoutMs,
      };

      const lib = isHttps ? https : http;
      const clientReq = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            clientReq.destroy(new Error(`EgressService: response exceeded ${maxBytes} byte limit`));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          // Buffer<ArrayBufferLike>[] is not assignable to Uint8Array[] in @types/node 26
          // due to a slice().buffer return-type divergence; safe cast at runtime.
          const bodyBuffer = Buffer.concat(chunks as unknown as Uint8Array[]);
          const responseHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") responseHeaders[k] = v;
            else if (Array.isArray(v)) responseHeaders[k] = v.join(", ");
          }
          const contentType =
            typeof res.headers["content-type"] === "string"
              ? res.headers["content-type"]
              : "application/octet-stream";
          resolve({
            status: res.statusCode ?? 0,
            headers: responseHeaders,
            bodyBuffer,
            contentType,
          });
        });

        res.on("error", reject);
      });

      clientReq.on("error", reject);
      clientReq.on("timeout", () => {
        clientReq.destroy(
          new Error(`EgressService: request to '${url.host}' timed out after ${timeoutMs}ms`),
        );
      });

      if (body !== undefined) {
        clientReq.write(body, "utf8");
      }
      clientReq.end();
    });
  }
}
