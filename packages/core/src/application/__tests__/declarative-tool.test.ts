import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { NoopBlobStorePort, NoopEgressPort, NoopSecretPort } from "@harness/core";
import {
  createDeclarativeTool,
  validateDeclarativeToolSpec,
} from "../declarative-tool.js";
import type { DeclarativeToolSpec } from "../declarative-tool.js";
import type { EgressRequest, EgressResponse } from "../../ports/egress.port.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseSpec: DeclarativeToolSpec = {
  id: "test-tool",
  description: "A test declarative tool",
  method: "GET",
  urlTemplate: "https://api.example.com/data?q={{input.query}}",
  headers: { Accept: "application/json" },
  responseMapping: "items",
  inputSchema: z.object({ query: z.string() }),
  inputJsonSchema: { type: "object", properties: { query: { type: "string" } } },
  outputJsonSchema: { type: "array" },
  allowedHosts: ["api.example.com"],
  dangerous: false,
  idempotent: true,
};

function makeMockEgress(response: Partial<EgressResponse> = {}): NoopEgressPort & {
  lastRequest: EgressRequest | null;
} {
  const port = new NoopEgressPort() as NoopEgressPort & { lastRequest: EgressRequest | null };
  port.lastRequest = null;
  port.fetch = vi.fn(async (req: EgressRequest): Promise<EgressResponse> => {
    port.lastRequest = req;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [1, 2, 3], meta: { total: 3 } }),
      ...response,
    };
  });
  return port;
}

// ---------------------------------------------------------------------------
// validateDeclarativeToolSpec
// ---------------------------------------------------------------------------

describe("validateDeclarativeToolSpec", () => {
  it("accepts a valid HTTPS URL with public hostname", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "https://api.example.com/v1/data",
        allowedHosts: ["api.example.com"],
      }),
    ).not.toThrow();
  });

  it("rejects http://169.254.169.254 (AWS metadata)", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "http://169.254.169.254/latest/meta-data",
        allowedHosts: [],
      }),
    ).toThrow(/blocked host/);
  });

  it("rejects metadata.google.internal", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "http://metadata.google.internal/computeMetadata/v1/",
        allowedHosts: [],
      }),
    ).toThrow(/blocked host/);
  });

  it("rejects 10.x.x.x literal IP in URL", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "http://10.0.0.1/admin",
        allowedHosts: [],
      }),
    ).toThrow(/blocked/);
  });

  it("rejects 192.168.x.x literal IP in URL", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "http://192.168.1.1:8080/api",
        allowedHosts: [],
      }),
    ).toThrow(/blocked/);
  });

  it("rejects localhost", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "http://localhost:3000/",
        allowedHosts: [],
      }),
    ).toThrow(/blocked host/);
  });

  it("accepts template placeholders in URL", () => {
    expect(() =>
      validateDeclarativeToolSpec({
        urlTemplate: "https://{{input.host}}/api", // host comes from input
        allowedHosts: [],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createDeclarativeTool — runtime behaviour
// ---------------------------------------------------------------------------

describe("createDeclarativeTool", () => {
  it("interpolates {{input.field}} in URL", async () => {
    const egress = makeMockEgress();
    const tool = createDeclarativeTool(baseSpec, {
      egress,
      secrets: new NoopSecretPort(),
      blobStore: new NoopBlobStorePort(),
    });

    await tool.execute({ query: "hello world" });

    expect(egress.lastRequest?.url).toBe(
      "https://api.example.com/data?q=hello world",
    );
  });

  it("applies responseMapping to extract nested field", async () => {
    const egress = makeMockEgress();
    const tool = createDeclarativeTool(baseSpec, {
      egress,
      secrets: new NoopSecretPort(),
      blobStore: new NoopBlobStorePort(),
    });

    const result = await tool.execute({ query: "test" });
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns full response when responseMapping is absent", async () => {
    const egress = makeMockEgress();
    // Omit responseMapping entirely (exactOptionalPropertyTypes forbids spreading undefined)
    const { responseMapping: _rm, ...specNoMapping } = baseSpec;
    const tool = createDeclarativeTool(
      specNoMapping,
      { egress, secrets: new NoopSecretPort(), blobStore: new NoopBlobStorePort() },
    );

    const result = await tool.execute({ query: "test" }) as Record<string, unknown>;
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("meta");
  });

  it("throws on non-2xx HTTP status", async () => {
    const egress = makeMockEgress({ status: 403, body: "Forbidden" });
    const tool = createDeclarativeTool(baseSpec, {
      egress,
      secrets: new NoopSecretPort(),
      blobStore: new NoopBlobStorePort(),
    });

    await expect(tool.execute({ query: "test" })).rejects.toThrow(/HTTP 403/);
  });

  it("passes allowedHosts to egress port", async () => {
    const egress = makeMockEgress();
    const tool = createDeclarativeTool(baseSpec, {
      egress,
      secrets: new NoopSecretPort(),
      blobStore: new NoopBlobStorePort(),
    });

    await tool.execute({ query: "test" });
    expect(egress.lastRequest?.allowedHosts).toEqual(["api.example.com"]);
  });

  it("forwards claim check reference when egress returns one", async () => {
    const claimCheck = { bucket: "claim-checks", key: "t1/123", sizeBytes: 300_000, contentType: "text/plain" };
    const egress = makeMockEgress({
      body: "preview...",
      claimCheck,
    });
    const { responseMapping: _rm2, ...specNoMapping2 } = baseSpec;
    const tool = createDeclarativeTool(specNoMapping2, {
      egress,
      secrets: new NoopSecretPort(),
      blobStore: new NoopBlobStorePort(),
    });

    const result = await tool.execute({ query: "big" }) as { claimCheck: unknown; preview: string };
    expect(result.claimCheck).toEqual(claimCheck);
    expect(result.preview).toBe("preview...");
  });
});
