/**
 * PostgresSecretStore — SecretPort backed by Postgres with envelope encryption.
 *
 * Pattern: Adapter (Hexagonal Architecture) + Envelope Encryption
 *
 * Each secret value is AES-256-GCM encrypted with a per-tenant DEK.
 * The DEK is wrapped (AES-256-GCM encrypted) by the KmsPort master key.
 * Wrapped DEKs are stored in `tenant_deks`; encrypted values in `secrets`.
 *
 * DEK rotation:
 *   1. Call kms.wrapKey(newDek) → new version row in tenant_deks.
 *   2. New secrets use the new DEK version.
 *   3. Existing secrets remain readable via their recorded dek_version.
 *   4. No re-encryption needed.
 *
 * All queries run inside withTenantCtx so RLS applies automatically.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsPort, SecretPort } from "@harness/core";
import type { SecretRecord } from "@harness/core";
import type { Pool } from "pg";
import { withTenantCtx } from "./db/tenant-transaction.js";

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEK_BYTES = 32;

// ---------------------------------------------------------------------------
// Uint8Array assembly — avoids Buffer.concat type issues in @types/node 22
// ---------------------------------------------------------------------------

function concatU8(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out as Uint8Array<ArrayBuffer>;
}

function encrypt(dek: Uint8Array, plaintext: string): string {
  const iv = Uint8Array.from(randomBytes(IV_BYTES));
  const safeKey = Uint8Array.from(dek);
  const cipher = createCipheriv("aes-256-gcm", safeKey, iv);
  const enc = Uint8Array.from(cipher.update(plaintext, "utf8"));
  const fin = Uint8Array.from(cipher.final());
  const tag = Uint8Array.from(cipher.getAuthTag());
  return Buffer.from(concatU8(iv, tag, enc, fin)).toString("base64");
}

function decrypt(dek: Uint8Array, ciphertext: string): string {
  const buf = Uint8Array.from(Buffer.from(ciphertext, "base64"));
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const data = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const safeKey = Uint8Array.from(dek);
  const decipher = createDecipheriv("aes-256-gcm", safeKey, Uint8Array.from(iv));
  decipher.setAuthTag(Uint8Array.from(tag));
  const dec = Uint8Array.from(decipher.update(Uint8Array.from(data)));
  const decFin = Uint8Array.from(decipher.final());
  return Buffer.from(concatU8(dec, decFin)).toString("utf8");
}

// ---------------------------------------------------------------------------
// PostgresSecretStore
// ---------------------------------------------------------------------------

export class PostgresSecretStore implements SecretPort {
  constructor(
    private readonly pool: Pool,
    private readonly kms: KmsPort,
  ) {}

  // ---------------------------------------------------------------------------
  // DEK management
  // ---------------------------------------------------------------------------

  private async getOrCreateDek(tenantId: string): Promise<{ dek: Uint8Array; version: number }> {
    const currentVersion = this.kms.currentVersion();

    return withTenantCtx(this.pool, tenantId, async (client) => {
      // Check if we already have a wrapped DEK for this tenant+version.
      // Column is `wrapped_dek` (schema from 0002_multi_tenancy.sql).
      const existing = await client.query<{ wrapped_dek: string }>(
        "SELECT wrapped_dek FROM tenant_deks WHERE tenant_id = $1 AND version = $2",
        [tenantId, currentVersion],
      );
      if (existing.rows[0]) {
        const dek = await this.kms.unwrapKey(existing.rows[0].wrapped_dek, currentVersion);
        return { dek, version: currentVersion };
      }

      // Create a new DEK for this tenant+version.
      const rawDek = Uint8Array.from(randomBytes(DEK_BYTES));
      const wrapped = await this.kms.wrapKey(rawDek);
      const newId = `dek-${tenantId}-v${wrapped.version}`;
      await client.query(
        `INSERT INTO tenant_deks (id, tenant_id, version, wrapped_dek, kms_key_id)
         VALUES ($1, $2, $3, $4, 'master')
         ON CONFLICT (tenant_id, version) DO NOTHING`,
        [newId, tenantId, wrapped.version, wrapped.wrapped],
      );
      // Re-fetch in case another process inserted concurrently
      const refetch = await client.query<{ wrapped_dek: string }>(
        "SELECT wrapped_dek FROM tenant_deks WHERE tenant_id = $1 AND version = $2",
        [tenantId, wrapped.version],
      );
      const actualDek = refetch.rows[0]
        ? await this.kms.unwrapKey(refetch.rows[0].wrapped_dek, wrapped.version)
        : rawDek;
      return { dek: actualDek, version: wrapped.version };
    });
  }

  private async getDekByVersion(tenantId: string, version: number): Promise<Uint8Array> {
    return withTenantCtx(this.pool, tenantId, async (client) => {
      const result = await client.query<{ wrapped_dek: string }>(
        "SELECT wrapped_dek FROM tenant_deks WHERE tenant_id = $1 AND version = $2",
        [tenantId, version],
      );
      if (!result.rows[0]) {
        throw new Error(`PostgresSecretStore: DEK v${version} not found for tenant '${tenantId}'`);
      }
      return this.kms.unwrapKey(result.rows[0].wrapped_dek, version);
    });
  }

  // ---------------------------------------------------------------------------
  // SecretPort implementation
  // ---------------------------------------------------------------------------

  async set(tenantId: string, name: string, plaintext: string): Promise<void> {
    const { dek, version } = await this.getOrCreateDek(tenantId);
    const ciphertext = encrypt(dek, plaintext);

    await withTenantCtx(this.pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO secrets (tenant_id, name, ciphertext, dek_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext,
               dek_version = EXCLUDED.dek_version,
               updated_at = NOW()`,
        [tenantId, name, ciphertext, version],
      );
    });
  }

  async resolve(tenantId: string, name: string): Promise<string | null> {
    const row = await withTenantCtx(this.pool, tenantId, async (client) => {
      const result = await client.query<{ ciphertext: string; dek_version: number }>(
        "SELECT ciphertext, dek_version FROM secrets WHERE tenant_id = $1 AND name = $2",
        [tenantId, name],
      );
      return result.rows[0] ?? null;
    });

    if (!row) return null;
    const dek = await this.getDekByVersion(tenantId, row.dek_version);
    return decrypt(dek, row.ciphertext);
  }

  async list(tenantId: string): Promise<Omit<SecretRecord, "ciphertext">[]> {
    return withTenantCtx(this.pool, tenantId, async (client) => {
      const result = await client.query<{
        name: string;
        dek_version: number;
        created_at: Date;
      }>(
        "SELECT name, dek_version, created_at FROM secrets WHERE tenant_id = $1 ORDER BY created_at DESC",
        [tenantId],
      );
      return result.rows.map((r) => ({
        name: r.name,
        dekVersion: r.dek_version,
        createdAt: r.created_at,
      }));
    });
  }

  async delete(tenantId: string, name: string): Promise<void> {
    await withTenantCtx(this.pool, tenantId, async (client) => {
      await client.query("DELETE FROM secrets WHERE tenant_id = $1 AND name = $2", [
        tenantId,
        name,
      ]);
    });
  }
}
