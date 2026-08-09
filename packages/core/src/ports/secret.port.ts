/**
 * SecretPort — named secrets per tenant, stored encrypted at rest.
 *
 * Pattern: Port (Hexagonal Architecture)
 * The concrete implementation lives in `@harness/adapters-postgres` (envelope
 * encryption with AES-256-GCM per-tenant DEK wrapped by a master key).
 * Tests use `InMemorySecretStore` from `@harness/adapters-memory`.
 *
 * Secrets are NEVER resolved here — resolution happens exclusively in
 * EgressService right before the outbound HTTP connection.
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export interface SecretRecord {
  name: string;
  /** AES-256-GCM ciphertext: base64(iv[12] ++ authTag[16] ++ ciphertext). */
  ciphertext: string;
  /** DEK version used to encrypt this value. Required for decryption. */
  dekVersion: number;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface SecretPort {
  /** Encrypt `plaintext` with the tenant's current DEK and persist it. */
  set(tenantId: string, name: string, plaintext: string): Promise<void>;

  /**
   * Decrypt and return the plaintext value for the named secret.
   * Returns `null` if the secret does not exist.
   */
  resolve(tenantId: string, name: string): Promise<string | null>;

  /** List metadata (no plaintexts) for all secrets of the tenant. */
  list(tenantId: string): Promise<Omit<SecretRecord, "ciphertext">[]>;

  /** Remove a secret. No-op if it does not exist. */
  delete(tenantId: string, name: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Noop implementation — always returns null (tests that don't need secrets)
// ---------------------------------------------------------------------------

export class NoopSecretPort implements SecretPort {
  async set(_tenantId: string, _name: string, _plaintext: string): Promise<void> {}

  async resolve(_tenantId: string, _name: string): Promise<string | null> {
    return null;
  }

  async list(_tenantId: string): Promise<Omit<SecretRecord, "ciphertext">[]> {
    return [];
  }

  async delete(_tenantId: string, _name: string): Promise<void> {}
}
