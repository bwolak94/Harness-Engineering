/**
 * BlobStorePort — large-object storage for the Claim Check pattern.
 *
 * Pattern: Port (Hexagonal Architecture) + Claim Check
 * When a tool response exceeds the claim-check threshold (default 256 kB),
 * EgressService uploads the body here and stores only a reference in the
 * event log. The model receives a short preview + the reference key.
 *
 * Production implementation: S3-compatible (MinIO / AWS S3).
 * Tests use `InMemoryBlobStore` from `@harness/adapters-memory`.
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export interface BlobRef {
  /** Bucket / container name. */
  bucket: string;
  /** Object key within the bucket. */
  key: string;
  /** Original size in bytes (before any compression). */
  sizeBytes: number;
  /** MIME content-type of the stored data. */
  contentType: string;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface BlobStorePort {
  /** Upload `data` and return its reference. Overwrites if key exists. */
  put(bucket: string, key: string, data: Buffer, contentType: string): Promise<BlobRef>;

  /** Download the blob identified by `ref`. Throws if not found. */
  get(ref: BlobRef): Promise<Buffer>;

  /** Remove the blob. No-op if it does not exist. */
  delete(ref: BlobRef): Promise<void>;
}

// ---------------------------------------------------------------------------
// Noop implementation — stores nothing; get() always throws
// ---------------------------------------------------------------------------

export class NoopBlobStorePort implements BlobStorePort {
  async put(bucket: string, key: string, data: Buffer, contentType: string): Promise<BlobRef> {
    return { bucket, key, sizeBytes: data.length, contentType };
  }

  async get(_ref: BlobRef): Promise<Buffer> {
    throw new Error("NoopBlobStorePort: blob retrieval not supported");
  }

  async delete(_ref: BlobRef): Promise<void> {}
}
