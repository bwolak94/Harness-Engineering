import { createHmac, timingSafeEqual } from "node:crypto";
import type { MemberRole, TenantContext } from "@harness/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// JWT payload shape expected in every request
// ---------------------------------------------------------------------------

interface JwtPayload {
  tenantId: string;
  userId: string;
  role: MemberRole;
  exp?: number;
  iat?: number;
}

// ---------------------------------------------------------------------------
// HS256 JWT verification (node:crypto, no external library)
// ---------------------------------------------------------------------------

/**
 * Decodes and verifies an HS256 JWT.
 *
 * Returns the parsed payload or throws with a descriptive message.
 * Uses `timingSafeEqual` to prevent timing-oracle attacks on the signature.
 */
function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected header.payload.signature");
  }
  // Non-null assertions safe: length === 3 checked above
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const headerB64 = parts[0]!;
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const payloadB64 = parts[1]!;
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const sigB64 = parts[2]!;

  // Re-compute expected signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest("base64url");

  // Constant-time comparison using TextEncoder to get Uint8Array (ArrayBuffer-backed,
  // not SharedArrayBuffer) — satisfies node:crypto timingSafeEqual's type constraints.
  const enc = new TextEncoder();
  const expectedBytes = enc.encode(expected);
  const actualBytes = enc.encode(sigB64);
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new Error("JWT signature verification failed");
  }

  // Decode payload
  const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson) as JwtPayload;

  // Expiry check
  if (payload.exp !== undefined && Date.now() / 1000 > payload.exp) {
    throw new Error("JWT expired");
  }

  if (!payload.tenantId || !payload.userId || !payload.role) {
    throw new Error("JWT payload missing required fields: tenantId, userId, role");
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

/**
 * Registers `req.tenantContext` on every request.
 *
 * Routes that require authentication should call `req.tenantContext` after
 * this middleware has run. Routes that don't need auth (health check, docs)
 * can skip this.
 *
 * The plugin attaches the tenantContext as undefined when no token is present;
 * individual routes decide whether to reject unauthenticated requests.
 */
export function registerAuthMiddleware(fastify: FastifyInstance, jwtSecret: string): void {
  // Extend Fastify's request type with tenantContext
  fastify.decorateRequest("tenantContext", null);

  fastify.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      // No token — tenantContext stays null; routes decide how to react
      return;
    }
    const token = authHeader.slice(7);
    try {
      const payload = verifyJwt(token, jwtSecret);
      (req as FastifyRequest & { tenantContext: TenantContext }).tenantContext = {
        tenantId: payload.tenantId,
        userId: payload.userId,
        role: payload.role,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid token";
      reply.status(401).send({ status: 401, title: "Unauthorized", detail: message });
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers for route handlers
// ---------------------------------------------------------------------------

/** Extracts TenantContext from the request or sends 401 and returns null. */
export function requireAuth(req: FastifyRequest, reply: FastifyReply): TenantContext | null {
  const ctx = (req as FastifyRequest & { tenantContext?: TenantContext }).tenantContext;
  if (!ctx) {
    reply
      .status(401)
      .send({ status: 401, title: "Unauthorized", detail: "Authentication required" });
    return null;
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Test helper — creates a signed HS256 JWT for use in tests
// ---------------------------------------------------------------------------

/**
 * Creates a test JWT signed with `secret`.
 * Do not use in production code.
 */
export function createTestJwt(payload: JwtPayload, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
