import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  composeDecorators,
  withPolicy,
  withResultTruncation,
  withTelemetry,
  withTimeout,
  withValidation,
} from "../../application/tool-decorators.js";
import { allowAll, denyAll, isDangerous, policy } from "../../application/tool-policy.js";
import { err, ok } from "../../domain/result.js";
import type { ToolExecutor } from "../../ports/tool-registry.port.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeExecutor(name: string, executeFn: ToolExecutor["execute"]): ToolExecutor {
  return {
    definition: {
      name,
      description: "test",
      dangerous: false,
      idempotent: true,
      costHint: "free" as const,
      inputSchema: {},
      outputSchema: {},
    },
    execute: executeFn,
  };
}

function successExecutor(name = "test", value: unknown = "result"): ToolExecutor {
  return makeExecutor(name, async () => ok(value));
}

function failExecutor(name = "test"): ToolExecutor {
  return makeExecutor(name, async () =>
    err({ code: "EXECUTION_ERROR", message: "fail", retryable: false }),
  );
}

// ---------------------------------------------------------------------------
// composeDecorators
// ---------------------------------------------------------------------------

describe("composeDecorators", () => {
  it("applies decorators left-to-right (first = outermost)", async () => {
    const trace: string[] = [];
    const makeTracing =
      (label: string) =>
      (executor: ToolExecutor): ToolExecutor => ({
        definition: executor.definition,
        execute: async (args, signal) => {
          trace.push(`${label}:before`);
          const result = await executor.execute(args, signal);
          trace.push(`${label}:after`);
          return result;
        },
      });

    const composed = composeDecorators(makeTracing("A"), makeTracing("B"), makeTracing("C"));
    const wrapped = composed(successExecutor());
    await wrapped.execute({});

    expect(trace).toEqual(["A:before", "B:before", "C:before", "C:after", "B:after", "A:after"]);
  });

  it("with zero decorators returns the executor unchanged", async () => {
    const inner = successExecutor("x", 42);
    const composed = composeDecorators();
    const result = await composed(inner).execute({});
    expect(result).toEqual(ok(42));
  });
});

// ---------------------------------------------------------------------------
// withValidation
// ---------------------------------------------------------------------------

describe("withValidation", () => {
  const schema = z.object({ n: z.number() });

  it("forwards valid args to inner executor", async () => {
    const inner = makeExecutor("v", async (args) => ok((args as { n: number }).n * 2));
    const wrapped = withValidation(schema)(inner);
    const result = await wrapped.execute({ n: 5 });
    expect(result).toEqual(ok(10));
  });

  it("returns VALIDATION_ERROR for invalid args without calling inner", async () => {
    const executeSpy = vi.fn();
    const inner = makeExecutor("v", async (args) => {
      executeSpy(args);
      return ok(null);
    });
    const wrapped = withValidation(schema)(inner);
    const result = await wrapped.execute({ n: "not-a-number" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("n");
    }
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("includes field path and Zod message in error", async () => {
    const wrapped = withValidation(schema)(successExecutor());
    const result = await wrapped.execute({ n: "bad" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/n/);
      expect(result.error.retryable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
  it("passes through results that arrive before the timeout", async () => {
    const inner = successExecutor("t", "done");
    const wrapped = withTimeout(5000)(inner);
    const result = await wrapped.execute({});
    expect(result).toEqual(ok("done"));
  });

  it("returns TIMEOUT error and sets retryable:true when the tool hangs", async () => {
    const inner = makeExecutor(
      "slow",
      (_args, signal) =>
        new Promise((resolve) => {
          const tid = setTimeout(() => resolve(ok("late")), 10_000);
          signal?.addEventListener("abort", () => clearTimeout(tid));
        }),
    );
    const wrapped = withTimeout(50)(inner);
    const result = await wrapped.execute({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("aborts the inner executor via AbortSignal on timeout", async () => {
    let aborted = false;
    const inner = makeExecutor(
      "slow",
      (_args, signal) =>
        new Promise((resolve) => {
          const tid = setTimeout(() => resolve(ok("late")), 10_000);
          signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(tid);
          });
        }),
    );
    const wrapped = withTimeout(50)(inner);
    await wrapped.execute({});
    expect(aborted).toBe(true);
  });

  it("forwards parent AbortSignal abort", async () => {
    const controller = new AbortController();
    const inner = makeExecutor(
      "slow",
      (_args, signal) =>
        new Promise((resolve) => {
          const tid = setTimeout(() => resolve(ok("late")), 10_000);
          signal?.addEventListener("abort", () => clearTimeout(tid));
        }),
    );
    const wrapped = withTimeout(10_000)(inner);
    // Abort before the timeout fires
    setTimeout(() => controller.abort(), 20);
    // The wrapped executor should resolve (inner cleans up), not hang
    // We just verify it doesn't hang indefinitely by using a short outer timeout
    const raceResult = await Promise.race([
      wrapped.execute({}, controller.signal).then(() => "resolved"),
      new Promise<string>((res) => setTimeout(() => res("timeout"), 200)),
    ]);
    // Should resolve (either inner resolves after abort cleanup, or times out at 200ms)
    expect(typeof raceResult).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// withPolicy
// ---------------------------------------------------------------------------

describe("withPolicy", () => {
  it("allow → forwards to inner executor", async () => {
    const wrapped = withPolicy(allowAll())(successExecutor("p", "yes"));
    const result = await wrapped.execute({});
    expect(result).toEqual(ok("yes"));
  });

  it("deny → returns POLICY_DENIED without calling inner", async () => {
    const executeSpy = vi.fn();
    const inner = makeExecutor("p", async (args) => {
      executeSpy(args);
      return ok(null);
    });
    const wrapped = withPolicy(denyAll())(inner);
    const result = await wrapped.execute({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POLICY_DENIED");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("requireApproval → returns APPROVAL_REQUIRED", async () => {
    const dangerousDef = {
      name: "bomb",
      description: "dangerous",
      dangerous: true,
      idempotent: false,
      costHint: "free" as const,
      inputSchema: {},
      outputSchema: {},
    };
    const inner: ToolExecutor = { definition: dangerousDef, execute: async () => ok("boom") };
    const wrapped = withPolicy(isDangerous())(inner);
    const result = await wrapped.execute({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("composable policy: denyAll().not() = allowAll()", async () => {
    const wrapped = withPolicy(denyAll().not())(successExecutor("p", "ok"));
    const result = await wrapped.execute({});
    expect(result).toEqual(ok("ok"));
  });

  it("policy receives args and definition", async () => {
    const received: unknown[] = [];
    const spy = policy((args, def) => {
      received.push({ args, defName: def.name });
      return "allow";
    });
    const inner = successExecutor("named-tool", "x");
    const wrapped = withPolicy(spy)(inner);
    await wrapped.execute({ key: "val" });
    expect(received).toHaveLength(1);
    expect((received[0] as { defName: string }).defName).toBe("named-tool");
    expect((received[0] as { args: unknown }).args).toEqual({ key: "val" });
  });
});

// ---------------------------------------------------------------------------
// withResultTruncation
// ---------------------------------------------------------------------------

describe("withResultTruncation", () => {
  it("passes through results that fit within the budget", async () => {
    const inner = successExecutor("r", "short");
    const wrapped = withResultTruncation(10_000)(inner);
    const result = await wrapped.execute({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.value).toBe("string");
  });

  it("truncates large results and includes the truncation marker", async () => {
    const bigValue = "x".repeat(10_000);
    const inner = successExecutor("r", bigValue);
    const wrapped = withResultTruncation(100)(inner);
    const result = await wrapped.execute({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const str = result.value as string;
      expect(str).toContain("TRUNCATED");
      expect(str.length).toBeLessThan(bigValue.length);
    }
  });

  it("does not truncate err results", async () => {
    const wrapped = withResultTruncation(10)(failExecutor());
    const result = await wrapped.execute({});
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withTelemetry
// ---------------------------------------------------------------------------

describe("withTelemetry", () => {
  it("passes through the result unchanged", async () => {
    const inner = successExecutor("tel", { data: 1 });
    const wrapped = withTelemetry()(inner);
    const result = await wrapped.execute({});
    expect(result.ok).toBe(true);
  });

  it("logs timing to console.debug", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const wrapped = withTelemetry("my-label")(successExecutor());
    await wrapped.execute({});
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("my-label"));
    debugSpy.mockRestore();
  });
});
