/**
 * KmsPort — wraps and unwraps Data Encryption Keys (DEKs).
 *
 * Pattern: Port (Hexagonal Architecture)
 * The production implementation uses AES-256-GCM with a master key from env.
 * Tests use `InMemoryKms` (identity wrapping — no actual encryption needed for
 * the port contract tests; encryption correctness is tested in the concrete impl).
 *
 * Envelope encryption:
 *   secret → AES-256-GCM(dek) → ciphertext
 *   dek    → KmsPort.wrapKey() → wrappedKey (stored in tenant_deks)
 *
 * Rotation: call wrapKey() to get a new version; old wrapped keys stay in DB so
 * existing secrets can still be decrypted via their recorded dekVersion.
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export interface WrappedKey {
  /** AES-256-GCM encrypted DEK: base64(iv[12] ++ authTag[16] ++ wrappedDek). */
  wrapped: string;
  /** Monotonically increasing version for this tenant's DEK. */
  version: number;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface KmsPort {
  /** Encrypt a 32-byte DEK with the current master key and return it wrapped. */
  wrapKey(dek: Uint8Array): Promise<WrappedKey>;

  /**
   * Decrypt a wrapped DEK, returning the original 32-byte key.
   * The `version` parameter is informational — implementations that support
   * multiple master-key versions use it to select the correct unwrapping key.
   */
  unwrapKey(wrapped: string, version: number): Promise<Uint8Array>;

  /** The version number that will be assigned to the next `wrapKey` call. */
  currentVersion(): number;
}

// ---------------------------------------------------------------------------
// Noop implementation — identity (no encryption); safe only in tests
// ---------------------------------------------------------------------------

export class NoopKmsPort implements KmsPort {
  private _version = 1;

  async wrapKey(dek: Uint8Array): Promise<WrappedKey> {
    return { wrapped: Buffer.from(dek).toString("base64"), version: this._version };
  }

  async unwrapKey(wrapped: string, _version: number): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped, "base64"));
  }

  currentVersion(): number {
    return this._version;
  }

  /** Simulate a key rotation for tests. */
  rotate(): void {
    this._version += 1;
  }
}
