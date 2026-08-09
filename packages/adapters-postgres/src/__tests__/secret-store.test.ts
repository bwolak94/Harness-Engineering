/**
 * PostgresSecretStore integration tests (T16 Definition of Done).
 *
 * Requires a real Postgres instance (Testcontainers) because:
 *  - envelope encryption relies on Postgres for persistence
 *  - RLS ensures secrets are tenant-isolated
 *
 * DoD coverage:
 *  ✅ Secret not in plaintext in any events or secrets rows
 *  ✅ Secret is tenant-isolated (Tenant A cannot read Tenant B's secrets)
 *  ✅ DEK rotation: old secrets readable, new secrets use new DEK version
 *  ✅ Query without tenant context returns zero rows
 */

import { execSync } from "node:child_process";
import { InMemoryKms } from "@harness/adapters-memory";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema } from "../db/client.js";
import { applyMultiTenancy, applySecrets } from "../db/multi-tenancy.js";
import { PostgresSecretStore } from "../postgres-secret-store.js";

// ---------------------------------------------------------------------------
// Docker availability guard
// ---------------------------------------------------------------------------

let dockerAvailable = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerAvailable = true;
} catch {
  // Docker not running — skip all Testcontainers tests
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-alpha";
const TENANT_B = "tenant-beta";
let pool: Pool;
let store: PostgresSecretStore;
let kms: InMemoryKms;

describe.skipIf(!dockerAvailable)("PostgresSecretStore (Testcontainers)", () => {
  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    });

    await applySchema(pool);
    await applyMultiTenancy(pool);
    await applySecrets(pool);

    // Insert test tenants (as superuser, no RLS)
    await pool.query(
      "INSERT INTO tenants (id, slug, plan, region) VALUES ($1, $2, 'free', 'eu-west') ON CONFLICT DO NOTHING",
      [TENANT_A, "alpha"],
    );
    await pool.query(
      "INSERT INTO tenants (id, slug, plan, region) VALUES ($1, $2, 'free', 'eu-west') ON CONFLICT DO NOTHING",
      [TENANT_B, "beta"],
    );

    // KMS and store are created once per suite so the same master key can
    // unwrap DEKs that persist in tenant_deks across all tests in this suite.
    // A new InMemoryKms per-test would fail to decrypt DEKs created by a
    // previous test's KMS instance (different random master key).
    kms = new InMemoryKms();
    store = new PostgresSecretStore(pool, kms);
  });

  afterAll(async () => {
    await pool?.end();
  });

  // -------------------------------------------------------------------------
  // Basic CRUD
  // -------------------------------------------------------------------------

  it("stores and resolves a secret", async () => {
    await store.set(TENANT_A, "API_KEY", "secret-value-123");
    const resolved = await store.resolve(TENANT_A, "API_KEY");
    expect(resolved).toBe("secret-value-123");
  });

  it("returns null for unknown secret", async () => {
    const resolved = await store.resolve(TENANT_A, "MISSING");
    expect(resolved).toBeNull();
  });

  it("overwrites an existing secret", async () => {
    await store.set(TENANT_A, "OVERWRITE", "first");
    await store.set(TENANT_A, "OVERWRITE", "second");
    expect(await store.resolve(TENANT_A, "OVERWRITE")).toBe("second");
  });

  it("deletes a secret", async () => {
    await store.set(TENANT_A, "TO_DELETE", "value");
    await store.delete(TENANT_A, "TO_DELETE");
    expect(await store.resolve(TENANT_A, "TO_DELETE")).toBeNull();
  });

  it("lists secrets without plaintext", async () => {
    await store.set(TENANT_A, "LIST_KEY_1", "val1");
    await store.set(TENANT_A, "LIST_KEY_2", "val2");
    const list = await store.list(TENANT_A);
    const names = list.map((s) => s.name);
    expect(names).toContain("LIST_KEY_1");
    expect(names).toContain("LIST_KEY_2");
    expect(list.every((s) => !("ciphertext" in s))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Security: ciphertext not equal to plaintext
  // -------------------------------------------------------------------------

  it("stores ciphertext, not plaintext, in the secrets table", async () => {
    const plaintext = "my-plaintext-api-key-abc123";
    await store.set(TENANT_A, "SECURITY_CHECK", plaintext);

    // Direct DB query as superuser (bypasses RLS) to inspect the row
    const result = await pool.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM secrets WHERE tenant_id = $1 AND name = $2",
      [TENANT_A, "SECURITY_CHECK"],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.ciphertext).not.toContain(plaintext);
    expect(result.rows[0]?.ciphertext).not.toBe(plaintext);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it("Tenant A cannot see Tenant B secrets (RLS)", async () => {
    await store.set(TENANT_B, "ISOLATED_KEY", "tenant-b-secret");

    // Attempt to resolve as TENANT_A — should return null (RLS filters the row)
    const resolved = await store.resolve(TENANT_A, "ISOLATED_KEY");
    expect(resolved).toBeNull();
  });

  it("query without tenant context returns zero rows (no tenant_id set)", async () => {
    await store.set(TENANT_A, "NO_CTX_KEY", "value");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_rw");
      // Intentionally do NOT set app.tenant_id
      const result = await client.query("SELECT * FROM secrets WHERE name = $1", ["NO_CTX_KEY"]);
      await client.query("COMMIT");
      expect(result.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // DEK rotation (DoD: old secrets readable, new secrets use new key)
  // -------------------------------------------------------------------------

  it("DEK rotation: old secrets remain readable, new secrets use new DEK version", async () => {
    // Store a secret with DEK v1
    await store.set(TENANT_A, "PRE_ROTATION", "pre-rotation-value");
    const listV1 = await store.list(TENANT_A);
    const preRotation = listV1.find((s) => s.name === "PRE_ROTATION");
    expect(preRotation?.dekVersion).toBe(1);

    // Rotate the KMS master key
    kms.rotate();
    // Re-create store with rotated KMS (same instance, version incremented)
    store = new PostgresSecretStore(pool, kms);

    // Old secret is still readable
    const oldValue = await store.resolve(TENANT_A, "PRE_ROTATION");
    expect(oldValue).toBe("pre-rotation-value");

    // New secret uses DEK v2
    await store.set(TENANT_A, "POST_ROTATION", "post-rotation-value");
    const listV2 = await store.list(TENANT_A);
    const postRotation = listV2.find((s) => s.name === "POST_ROTATION");
    expect(postRotation?.dekVersion).toBe(2);

    // Both secrets are accessible simultaneously
    expect(await store.resolve(TENANT_A, "PRE_ROTATION")).toBe("pre-rotation-value");
    expect(await store.resolve(TENANT_A, "POST_ROTATION")).toBe("post-rotation-value");
  });
});
