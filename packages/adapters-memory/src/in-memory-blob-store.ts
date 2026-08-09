/**
 * InMemoryBlobStore — BlobStorePort backed by an in-memory Map.
 *
 * Used in tests for the Claim Check pattern. Provides a `size()` helper
 * so tests can assert blobs were stored.
 */

import type { BlobRef, BlobStorePort } from "@harness/core";

export class InMemoryBlobStore implements BlobStorePort {
  private readonly store = new Map<string, { data: Buffer; contentType: string }>();

  private storeKey(ref: Pick<BlobRef, "bucket" | "key">): string {
    return `${ref.bucket}/${ref.key}`;
  }

  async put(bucket: string, key: string, data: Buffer, contentType: string): Promise<BlobRef> {
    this.store.set(`${bucket}/${key}`, { data, contentType });
    return { bucket, key, sizeBytes: data.length, contentType };
  }

  async get(ref: BlobRef): Promise<Buffer> {
    const entry = this.store.get(this.storeKey(ref));
    if (!entry) {
      throw new Error(`InMemoryBlobStore: blob '${ref.bucket}/${ref.key}' not found`);
    }
    return entry.data;
  }

  async delete(ref: BlobRef): Promise<void> {
    this.store.delete(this.storeKey(ref));
  }

  /** Number of stored blobs (for test assertions). */
  size(): number {
    return this.store.size;
  }

  /** Clear all stored blobs. */
  clear(): void {
    this.store.clear();
  }
}
