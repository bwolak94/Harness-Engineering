/**
 * InMemorySecretStore — SecretPort backed by an in-memory Map.
 *
 * Uses AES-256-GCM via the injected KmsPort for envelope encryption so the
 * pattern is real — only the persistence layer (Map vs Postgres) is swapped.
 * This makes secret-redaction and rotations testable without a database.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsPort, SecretPort } from "@harness/core";
import type { SecretRecord } from "@harness/core";

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

interface StoredSecret {
  ciphertext: string;
  dekVersion: number;
  createdAt: Date;
}

export class InMemorySecretStore implements SecretPort {
  /** Map from `${tenantId}::${name}` → stored secret */
  private readonly store = new Map<string, StoredSecret>();
  /** Map from `${tenantId}::${version}` → wrapped DEK */
  private readonly deks = new Map<string, string>();

  constructor(private readonly kms: KmsPort) {}

  private key(tenantId: string, name: string): string {
    return `${tenantId}::${name}`;
  }

  private dekKey(tenantId: string, version: number): string {
    return `${tenantId}::v${version}`;
  }

  /** Get or create the current DEK for a tenant (wrapped, stored in deks map). */
  private async getOrCreateDek(tenantId: string): Promise<{ dek: Uint8Array; version: number }> {
    const currentVersion = this.kms.currentVersion();
    const dk = this.dekKey(tenantId, currentVersion);
    const existing = this.deks.get(dk);
    if (existing) {
      const dek = await this.kms.unwrapKey(existing, currentVersion);
      return { dek, version: currentVersion };
    }
    // Create a new DEK for this tenant+version
    const rawDek = Uint8Array.from(randomBytes(DEK_BYTES));
    const wrapped = await this.kms.wrapKey(rawDek);
    this.deks.set(dk, wrapped.wrapped);
    return { dek: rawDek, version: wrapped.version };
  }

  private async getDek(tenantId: string, version: number): Promise<Uint8Array> {
    const dk = this.dekKey(tenantId, version);
    const wrapped = this.deks.get(dk);
    if (!wrapped) {
      throw new Error(`InMemorySecretStore: DEK v${version} not found for tenant '${tenantId}'`);
    }
    return this.kms.unwrapKey(wrapped, version);
  }

  async set(tenantId: string, name: string, plaintext: string): Promise<void> {
    const { dek, version } = await this.getOrCreateDek(tenantId);
    const ciphertext = encrypt(dek, plaintext);
    this.store.set(this.key(tenantId, name), {
      ciphertext,
      dekVersion: version,
      createdAt: new Date(),
    });
  }

  async resolve(tenantId: string, name: string): Promise<string | null> {
    const record = this.store.get(this.key(tenantId, name));
    if (!record) return null;
    const dek = await this.getDek(tenantId, record.dekVersion);
    return decrypt(dek, record.ciphertext);
  }

  async list(tenantId: string): Promise<Omit<SecretRecord, "ciphertext">[]> {
    const results: Omit<SecretRecord, "ciphertext">[] = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(`${tenantId}::`)) {
        const name = k.slice(tenantId.length + 2);
        results.push({ name, dekVersion: v.dekVersion, createdAt: v.createdAt });
      }
    }
    return results;
  }

  async delete(tenantId: string, name: string): Promise<void> {
    this.store.delete(this.key(tenantId, name));
  }

  /** Number of secrets stored (for test assertions). */
  size(): number {
    return this.store.size;
  }
}
