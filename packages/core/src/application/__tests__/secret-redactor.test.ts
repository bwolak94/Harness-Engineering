import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsInObject } from "../secret-redactor.js";

describe("redactSecrets", () => {
  it("replaces known secret values with [REDACTED]", () => {
    const result = redactSecrets("Call with key=abc123secret", ["abc123secret"]);
    expect(result).toBe("Call with key=[REDACTED]");
  });

  it("replaces multiple occurrences of the same secret", () => {
    const result = redactSecrets("a=secret1 b=secret1", ["secret1"]);
    expect(result).toBe("a=[REDACTED] b=[REDACTED]");
  });

  it("redacts longest secret first to prevent partial replacement", () => {
    const result = redactSecrets("key=longersecret123", ["secret123", "longersecret123"]);
    expect(result).toBe("key=[REDACTED]");
  });

  it("returns original string unchanged if no secrets match", () => {
    const original = "no sensitive data here";
    expect(redactSecrets(original, [])).toBe(original);
    expect(redactSecrets(original, ["other"])).toBe(original);
  });

  it("redacts OpenAI-style sk- keys", () => {
    const result = redactSecrets("Authorization: Bearer sk-abcdefghijklmnopqrst12345", []);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdefghijklmnopqrst12345");
  });

  it("redacts Bearer tokens in Authorization headers", () => {
    const result = redactSecrets('{"Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"}', []);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("does not modify empty text", () => {
    expect(redactSecrets("", ["secret"])).toBe("");
  });

  it("handles empty secrets list gracefully", () => {
    const text = "public data";
    expect(redactSecrets(text, [])).toBe(text);
  });

  it("skips empty string secrets to prevent replacing everything", () => {
    const text = "some text";
    expect(redactSecrets(text, [""])).toBe(text);
  });
});

describe("redactSecretsInObject", () => {
  it("redacts secrets in nested object string values", () => {
    const obj = {
      request: {
        headers: { Authorization: "Bearer my-secret-token" },
      },
      status: 200,
    };
    const redacted = redactSecretsInObject(obj, ["my-secret-token"]) as typeof obj;
    expect(JSON.stringify(redacted)).not.toContain("my-secret-token");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
  });

  it("returns original value when nothing to redact", () => {
    const obj = { key: "value", count: 42 };
    expect(redactSecretsInObject(obj, [])).toBe(obj); // same reference
  });
});
