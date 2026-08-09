/**
 * InMemoryKms — AES-256-GCM key wrapping using node:crypto.
 *
 * Used in tests and single-tenant local dev where a real KMS is overkill.
 * The master key is a 32-byte random value generated at construction time
 * (or passed in for reproducible tests).
 *
 * Supports key rotation via `rotate()` — increments the version counter and
 * wraps future DEKs with the new master key (old wrapped DEKs remain valid
 * because we keep the master key in a per-version map).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsPort, WrappedKey } from "@harness/core";

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// ---------------------------------------------------------------------------
// Uint8Array assembly helpers
//
// @types/node 22 changed Buffer.concat to require Uint8Array<ArrayBuffer>[]
// (not ArrayBufferLike[]). All node:crypto functions return Buffer which is
// typed as Uint8Array<ArrayBufferLike>. We avoid Buffer.concat entirely by
// assembling output into a fresh Uint8Array<ArrayBuffer> via .set().
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

function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): string {
  const iv = Uint8Array.from(randomBytes(IV_BYTES));
  const safeKey = Uint8Array.from(key);
  const cipher = createCipheriv("aes-256-gcm", safeKey, iv);
  const enc = Uint8Array.from(cipher.update(Uint8Array.from(plaintext)));
  const fin = Uint8Array.from(cipher.final());
  const tag = Uint8Array.from(cipher.getAuthTag());
  return Buffer.from(concatU8(iv, tag, enc, fin)).toString("base64");
}

function aesGcmDecrypt(key: Uint8Array, encoded: string): Uint8Array {
  const buf = Uint8Array.from(Buffer.from(encoded, "base64"));
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const safeKey = Uint8Array.from(key);
  const decipher = createDecipheriv("aes-256-gcm", safeKey, Uint8Array.from(iv));
  decipher.setAuthTag(Uint8Array.from(tag));
  const dec = Uint8Array.from(decipher.update(Uint8Array.from(ciphertext)));
  const decFin = Uint8Array.from(decipher.final());
  return concatU8(dec, decFin);
}

export class InMemoryKms implements KmsPort {
  private readonly keys = new Map<number, Uint8Array>();
  private version: number;

  constructor(masterKey?: Uint8Array) {
    this.version = 1;
    this.keys.set(1, masterKey ?? Uint8Array.from(randomBytes(32)));
  }

  async wrapKey(dek: Uint8Array): Promise<WrappedKey> {
    const masterKey = this.keys.get(this.version);
    if (!masterKey) throw new Error(`InMemoryKms: no key for version ${this.version}`);
    const wrapped = aesGcmEncrypt(masterKey, dek);
    return { wrapped, version: this.version };
  }

  async unwrapKey(wrapped: string, version: number): Promise<Uint8Array> {
    const masterKey = this.keys.get(version);
    if (!masterKey) {
      throw new Error(`InMemoryKms: unknown key version ${version}`);
    }
    return aesGcmDecrypt(masterKey, wrapped);
  }

  currentVersion(): number {
    return this.version;
  }

  /**
   * Simulate a key rotation: generate a new master key and bump the version.
   * Old wrapped DEKs (encrypted with previous versions) remain decryptable.
   */
  rotate(newMasterKey?: Uint8Array): void {
    this.version += 1;
    this.keys.set(this.version, newMasterKey ?? Uint8Array.from(randomBytes(32)));
  }
}
