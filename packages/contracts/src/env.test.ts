import { describe, expect, it, vi } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  const validEnv = {
    DATABASE_URL: "postgresql://harness:harness@localhost:5432/harness",
    LLM_API_KEY: "sk-test-key",
  };

  it("returns parsed env with defaults when required fields are present", () => {
    const env = parseEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.LLM_API_KEY).toBe(validEnv.LLM_API_KEY);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.NODE_ENV).toBe("development");
    expect(env.LLM_MODEL).toBe("gpt-4o-mini");
  });

  it("respects overrides for optional fields", () => {
    const env = parseEnv({
      ...validEnv,
      PORT: "8080",
      NODE_ENV: "production",
      LLM_MODEL: "gpt-4o",
    } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe("production");
    expect(env.LLM_MODEL).toBe("gpt-4o");
  });

  it("exits process with readable message when DATABASE_URL is missing", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseEnv({ LLM_API_KEY: "sk-x" } as NodeJS.ProcessEnv)).toThrow(
      "process.exit called",
    );

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it("exits process with readable message when LLM_API_KEY is missing", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      parseEnv({
        DATABASE_URL: "postgresql://x:x@localhost/x",
      } as NodeJS.ProcessEnv),
    ).toThrow("process.exit called");

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining("LLM_API_KEY"));

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it("coerces PORT string to number", () => {
    const env = parseEnv({ ...validEnv, PORT: "9000" } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(9000);
    expect(typeof env.PORT).toBe("number");
  });

  it("optional APPROVAL_WEBHOOK_URL is undefined when not set", () => {
    const env = parseEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.APPROVAL_WEBHOOK_URL).toBeUndefined();
  });
});
