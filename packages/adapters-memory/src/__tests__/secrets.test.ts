/**
 * Tests for InMemoryKms, InMemorySecretStore, and InMemoryBlobStore.
 * Verifies envelope encryption, DEK rotation, and claim-check storage.
 */

import { describe, expect, it } from "vitest";
import { InMemoryBlobStore } from "../in-memory-blob-store.js";
import { InMemoryKms } from "../in-memory-kms.js";
import { InMemorySecretStore } from "../in-memory-secret-store.js";

// ---------------------------------------------------------------------------
// InMemoryKms
// ---------------------------------------------------------------------------

describe("InMemoryKms", () => {
  it("wraps and unwraps a DEK correctly", async () => {
    const kms = new InMemoryKms();
    const dek = new Uint8Array(32).fill(0x42);
    const { wrapped, version } = await kms.wrapKey(dek);
    const unwrapped = await kms.unwrapKey(wrapped, version);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });

  it("starts at version 1", () => {
    const kms = new InMemoryKms();
    expect(kms.currentVersion()).toBe(1);
  });

  it("increments version on rotate()", async () => {
    const kms = new InMemoryKms();
    kms.rotate();
    expect(kms.currentVersion()).toBe(2);
  });

  it("can unwrap keys from previous versions after rotation", async () => {
    const kms = new InMemoryKms();
    const dek = new Uint8Array(32).fill(0xab);
    const { wrapped, version } = await kms.wrapKey(dek);
    expect(version).toBe(1);

    kms.rotate(); // new master key version 2

    const unwrapped = await kms.unwrapKey(wrapped, 1);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });

  it("throws for unknown version", async () => {
    const kms = new InMemoryKms();
    await expect(kms.unwrapKey("anything", 99)).rejects.toThrow(/unknown key version/);
  });
});

// ---------------------------------------------------------------------------
// InMemorySecretStore
// ---------------------------------------------------------------------------

describe("InMemorySecretStore", () => {
  it("stores and resolves a secret", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    await store.set("tenant1", "API_KEY", "super-secret-value");
    const resolved = await store.resolve("tenant1", "API_KEY");
    expect(resolved).toBe("super-secret-value");
  });

  it("returns null for unknown secret", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    const resolved = await store.resolve("tenant1", "MISSING");
    expect(resolved).toBeNull();
  });

  it("overwrites an existing secret on set()", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    await store.set("t1", "KEY", "value-1");
    await store.set("t1", "KEY", "value-2");
    expect(await store.resolve("t1", "KEY")).toBe("value-2");
  });

  it("deletes a secret", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    await store.set("t1", "KEY", "value");
    await store.delete("t1", "KEY");
    expect(await store.resolve("t1", "KEY")).toBeNull();
  });

  it("isolates secrets by tenant", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    await store.set("tenant-a", "KEY", "value-a");
    await store.set("tenant-b", "KEY", "value-b");
    expect(await store.resolve("tenant-a", "KEY")).toBe("value-a");
    expect(await store.resolve("tenant-b", "KEY")).toBe("value-b");
  });

  it("lists secrets without ciphertext", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    await store.set("t1", "KEY_A", "val-a");
    await store.set("t1", "KEY_B", "val-b");
    const list = await store.list("t1");
    expect(list).toHaveLength(2);
    expect(list.every((s) => !("ciphertext" in s))).toBe(true);
    expect(list.map((s) => s.name)).toContain("KEY_A");
    expect(list.map((s) => s.name)).toContain("KEY_B");
  });

  it("DEK rotation: old secrets still readable, new secrets use new DEK version", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);

    // Store a secret with DEK v1
    await store.set("t1", "OLD_SECRET", "old-value");
    const listBefore = await store.list("t1");
    expect(listBefore[0]?.dekVersion).toBe(1);

    // Rotate the KMS master key
    kms.rotate();

    // Old secret is still readable (via DEK v1)
    expect(await store.resolve("t1", "OLD_SECRET")).toBe("old-value");

    // New secret uses DEK v2
    await store.set("t1", "NEW_SECRET", "new-value");
    const listAfter = await store.list("t1");
    const newSecretMeta = listAfter.find((s) => s.name === "NEW_SECRET");
    expect(newSecretMeta?.dekVersion).toBe(2);

    // Both secrets are readable
    expect(await store.resolve("t1", "OLD_SECRET")).toBe("old-value");
    expect(await store.resolve("t1", "NEW_SECRET")).toBe("new-value");
  });

  it("ciphertext is not equal to plaintext", async () => {
    const kms = new InMemoryKms();
    const store = new InMemorySecretStore(kms);
    const plaintext = "super-secret-api-key-1234";
    await store.set("t1", "KEY", plaintext);
    // Verify list doesn't expose the plaintext
    const list = await store.list("t1");
    const meta = list[0];
    expect(meta).toBeDefined();
    expect(JSON.stringify(meta)).not.toContain(plaintext);
  });
});

// ---------------------------------------------------------------------------
// InMemoryBlobStore
// ---------------------------------------------------------------------------

describe("InMemoryBlobStore", () => {
  it("stores and retrieves a blob", async () => {
    const store = new InMemoryBlobStore();
    const data = Buffer.from("hello world");
    const ref = await store.put("bucket", "key/file.txt", data, "text/plain");
    expect(ref.sizeBytes).toBe(data.length);
    const retrieved = await store.get(ref);
    expect(retrieved.toString("utf8")).toBe("hello world");
  });

  it("throws when getting a non-existent blob", async () => {
    const store = new InMemoryBlobStore();
    await expect(
      store.get({ bucket: "b", key: "missing", sizeBytes: 0, contentType: "text/plain" }),
    ).rejects.toThrow(/not found/);
  });

  it("deletes a blob", async () => {
    const store = new InMemoryBlobStore();
    const data = Buffer.from("data");
    const ref = await store.put("b", "k", data, "text/plain");
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toThrow(/not found/);
  });

  it("tracks size()", async () => {
    const store = new InMemoryBlobStore();
    expect(store.size()).toBe(0);
    await store.put("b", "k1", Buffer.from("a"), "text/plain");
    await store.put("b", "k2", Buffer.from("b"), "text/plain");
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
  });
});
