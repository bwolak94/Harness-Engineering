/**
 * Declarative tool builder — compiles a DeclarativeToolSpec into a Tool<>.
 *
 * Pattern: Interpreter (mini-DSL)
 * The spec is pure data (method, URL template, headers, JSONPath mapping).
 * No code is generated. The tool is interpreted, not compiled.
 *
 * Pattern: Ambassador / Egress Gateway
 * All outbound HTTP is routed through EgressPort so SSRF protection, secret
 * substitution, DNS pinning, and claim-check happen in one place.
 *
 * Static validation (validateDeclarativeToolSpec) must be called at tool save
 * time to reject RFC1918/link-local IP addresses before they reach the DB.
 * The EgressService re-validates at call time (defence in depth).
 */

import type { ToolDefinition } from "@harness/contracts";
import type { z } from "zod";
import type { BlobStorePort } from "../ports/blob-store.port.js";
import type { EgressPort } from "../ports/egress.port.js";
import type { SecretPort } from "../ports/secret.port.js";
import type { Tool } from "./tool.js";

// ---------------------------------------------------------------------------
// Spec type
// ---------------------------------------------------------------------------

export interface DeclarativeToolSpec {
  /** Unique tool identifier — used as ToolDefinition.name. */
  id: string;
  /** Human-readable description for the model. */
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * URL template — supports:
   *   {{input.fieldName}}   — substituted from validated tool input
   *   {{secrets.NAME}}      — resolved by EgressService (never here)
   */
  urlTemplate: string;
  /** Request headers. Values may contain {{secrets.NAME}} placeholders. */
  headers?: Record<string, string>;
  /**
   * JSON body template. Supports {{input.fieldName}} substitutions.
   * Absent for GET/DELETE.
   */
  bodyTemplate?: string;
  /**
   * Dot-path (e.g. "data.items") to extract from the JSON response.
   * If absent the full parsed response is returned.
   */
  responseMapping?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Zod schema _input varies when fields have .default()
  inputSchema: z.ZodType<unknown, z.ZodTypeDef, any>;
  inputJsonSchema: ToolDefinition["inputSchema"];
  outputJsonSchema: ToolDefinition["outputSchema"];
  /** Allowlist of hostnames the tool is permitted to call. */
  allowedHosts: string[];
  dangerous: boolean;
  idempotent: boolean;
}

// ---------------------------------------------------------------------------
// Static SSRF guard (called at save time)
// ---------------------------------------------------------------------------

/**
 * RFC1918 + link-local + metadata CIDRs that must never appear as literal
 * IP addresses in a tool URL.
 *
 * Full dynamic SSRF protection (DNS resolution) lives in EgressService.
 * This function is a lightweight pre-check for obvious misconfigurations.
 */
const BLOCKED_LITERAL_PATTERNS: RegExp[] = [
  // loopback
  /^127\./,
  // RFC1918
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  // link-local / AWS metadata
  /^169\.254\./,
  // IPv6 loopback and ULA
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.aws.internal",
  "169.254.169.254",
  "fd00:ec2::254",
  "localhost",
]);

/**
 * Validate a DeclarativeToolSpec before persisting it.
 * Throws a descriptive Error if the URL or allowedHosts contain blocked
 * literal IP addresses or known metadata hostnames.
 */
export function validateDeclarativeToolSpec(spec: {
  urlTemplate: string;
  allowedHosts: string[];
}): void {
  const urlsToCheck = [spec.urlTemplate, ...spec.allowedHosts];
  for (const raw of urlsToCheck) {
    // Extract hostname from the URL if it looks like one
    let hostname: string;
    try {
      // Replace template placeholders so URL() can parse it
      const sanitised = raw.replace(/\{\{[^}]+\}\}/g, "placeholder");
      hostname = new URL(sanitised).hostname.toLowerCase();
    } catch {
      hostname = raw.toLowerCase();
    }

    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new Error(
        `Declarative tool URL references blocked host '${hostname}'. RFC1918, link-local, and cloud-metadata endpoints are not permitted.`,
      );
    }

    for (const pattern of BLOCKED_LITERAL_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new Error(
          `Declarative tool URL references blocked IP/host '${hostname}'. RFC1918, link-local, and cloud-metadata endpoints are not permitted.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

/** Substitute {{input.field}} placeholders with values from the input object. */
function interpolateInput(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{input\.([^}]+)\}\}/g, (_match, path: string) => {
    const value = resolvePath(input, path);
    return value !== undefined ? String(value) : "";
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Extract a value from a parsed JSON object by dot-path. */
function extractByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface DeclarativeToolPorts {
  egress: EgressPort;
  secrets: SecretPort;
  blobStore: BlobStorePort;
}

/**
 * Compile a `DeclarativeToolSpec` into a `Tool<unknown, unknown>`.
 *
 * The returned Tool goes through the standard decorator stack at call time
 * (policy, timeout, truncation, telemetry) — this factory only handles the
 * HTTP invocation logic.
 */
export function createDeclarativeTool(
  spec: DeclarativeToolSpec,
  ports: DeclarativeToolPorts,
): Tool<unknown, unknown> {
  const definition: ToolDefinition = {
    name: spec.id,
    description: spec.description,
    dangerous: spec.dangerous,
    idempotent: spec.idempotent,
    costHint: "moderate",
    inputSchema: spec.inputJsonSchema,
    outputSchema: spec.outputJsonSchema,
  };

  return {
    definition,
    inputSchema: spec.inputSchema,

    async execute(input: unknown): Promise<unknown> {
      const rawInput = input as Record<string, unknown>;

      const url = interpolateInput(spec.urlTemplate, rawInput);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.headers ?? {})) {
        headers[k] = interpolateInput(v, rawInput);
      }

      let body: string | undefined;
      if (spec.bodyTemplate) {
        body = interpolateInput(spec.bodyTemplate, rawInput);
      }

      const response = await ports.egress.fetch({
        method: spec.method,
        url,
        headers,
        // exactOptionalPropertyTypes: omit body when undefined rather than setting body: undefined
        ...(body !== undefined ? { body } : {}),
        allowedHosts: spec.allowedHosts,
        tenantId: "", // caller injects tenant context via tool-decorators
        timeoutMs: 30_000,
        maxResponseBytes: 10 * 1024 * 1024, // 10 MB hard limit
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Declarative tool '${spec.id}' received HTTP ${response.status}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body) as unknown;
      } catch {
        parsed = response.body;
      }

      const result = spec.responseMapping ? extractByPath(parsed, spec.responseMapping) : parsed;

      if (response.claimCheck) {
        return {
          preview: response.body,
          claimCheck: response.claimCheck,
        };
      }

      return result;
    },
  };
}
