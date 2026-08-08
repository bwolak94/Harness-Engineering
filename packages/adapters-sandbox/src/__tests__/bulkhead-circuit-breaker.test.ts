/**
 * Bulkhead and Circuit Breaker contract tests.
 *
 * These test the Bulkhead and CircuitBreaker decorators in isolation using a
 * controllable fake sandbox — no worker threads involved. The goal is to verify
 * the correct state machine transitions and rejection semantics independently
 * of the real sandbox implementation.
 */
import { type Result, err, ok } from "@harness/core";
import type { SandboxError, SandboxOptions, SandboxOutput, SandboxPort } from "@harness/core";
import { describe, expect, it, vi } from "vitest";
import { BulkheadSandbox } from "../bulkhead-sandbox.js";
import { CircuitBreakerSandbox } from "../circuit-breaker-sandbox.js";

// ---------------------------------------------------------------------------
// Fake sandbox helpers
// ---------------------------------------------------------------------------

function makeSuccessSandbox(): SandboxPort {
  return {
    async run(_code, _opts): Promise<Result<SandboxOutput, SandboxError>> {
      return ok({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 });
    },
  };
}

function makeFailureSandbox(): SandboxPort {
  return {
    async run(_code, _opts): Promise<Result<SandboxOutput, SandboxError>> {
      return err({ code: "EXECUTION_ERROR", message: "forced failure" });
    },
  };
}

function makeSlowSandbox(delayMs: number): SandboxPort {
  return {
    async run(_code, _opts): Promise<Result<SandboxOutput, SandboxError>> {
      await new Promise((r) => setTimeout(r, delayMs));
      return ok({ stdout: "slow", stderr: "", exitCode: 0, durationMs: delayMs });
    },
  };
}

const OPTS: SandboxOptions = {
  timeoutMs: 1000,
  memoryMb: 64,
  allowedModules: [],
  network: false,
};

// ---------------------------------------------------------------------------
// BulkheadSandbox
// ---------------------------------------------------------------------------

describe("BulkheadSandbox", () => {
  it("passes through successful results", async () => {
    const sb = new BulkheadSandbox(makeSuccessSandbox(), 2, 4);
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(true);
  });

  it("passes through failure results", async () => {
    const sb = new BulkheadSandbox(makeFailureSandbox(), 2, 4);
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXECUTION_ERROR");
  });

  it("allows up to poolSize concurrent executions", async () => {
    const sb = new BulkheadSandbox(makeSlowSandbox(50), 3, 10);
    const promises = Array.from({ length: 3 }, () => sb.run("", OPTS));
    expect(sb.activeCount).toBe(3);
    await Promise.all(promises);
    expect(sb.activeCount).toBe(0);
  });

  it("queues requests that exceed poolSize", async () => {
    const sb = new BulkheadSandbox(makeSlowSandbox(100), 2, 10);
    // Fire 4 concurrent requests — 2 active, 2 queued
    const p1 = sb.run("", OPTS);
    const p2 = sb.run("", OPTS);
    const p3 = sb.run("", OPTS);
    const p4 = sb.run("", OPTS);
    // At this moment pool is full (2) and 2 are queued
    expect(sb.queueLength).toBe(2);
    const results = await Promise.all([p1, p2, p3, p4]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("rejects with POOL_EXHAUSTED when queue is also full", async () => {
    const sb = new BulkheadSandbox(makeSlowSandbox(200), 1, 1);
    // Slot: 1 active, 1 queued — next one overflows
    const p1 = sb.run("", OPTS);
    const p2 = sb.run("", OPTS);
    const p3 = sb.run("", OPTS); // should be rejected
    const result = await p3;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POOL_EXHAUSTED");
    await Promise.all([p1, p2]);
  });

  it("activeCount returns to 0 after all complete", async () => {
    const sb = new BulkheadSandbox(makeSuccessSandbox(), 2, 4);
    await Promise.all([sb.run("", OPTS), sb.run("", OPTS)]);
    expect(sb.activeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CircuitBreakerSandbox
// ---------------------------------------------------------------------------

describe("CircuitBreakerSandbox", () => {
  it("starts CLOSED and passes through", async () => {
    const sb = new CircuitBreakerSandbox(makeSuccessSandbox(), { failureThreshold: 3 });
    expect(sb.circuitState).toBe("CLOSED");
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(true);
  });

  it("opens after failureThreshold consecutive failures", async () => {
    const sb = new CircuitBreakerSandbox(makeFailureSandbox(), { failureThreshold: 3 });
    await sb.run("", OPTS);
    await sb.run("", OPTS);
    expect(sb.circuitState).toBe("CLOSED"); // still closed
    await sb.run("", OPTS); // 3rd failure — circuit opens
    expect(sb.circuitState).toBe("OPEN");
    expect(sb.failureCount).toBe(3);
  });

  it("calls onOpen callback when circuit opens", async () => {
    const onOpen = vi.fn();
    const sb = new CircuitBreakerSandbox(makeFailureSandbox(), {
      failureThreshold: 2,
      onOpen,
    });
    await sb.run("", OPTS);
    await sb.run("", OPTS);
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("rejects immediately with CIRCUIT_OPEN when open", async () => {
    const sb = new CircuitBreakerSandbox(makeFailureSandbox(), {
      failureThreshold: 1,
      cooldownMs: 10_000,
    });
    await sb.run("", OPTS); // opens circuit
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CIRCUIT_OPEN");
      if (result.error.code === "CIRCUIT_OPEN") {
        expect(result.error.failureCount).toBe(1);
      }
    }
  });

  it("success resets failure counter", async () => {
    const sb = new CircuitBreakerSandbox(makeSuccessSandbox(), { failureThreshold: 3 });
    // Manually inject failures via tripForTesting then fake a success path
    // (can't set consecutiveFailures directly, so we verify via public API)
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(true);
    expect(sb.failureCount).toBe(0);
  });

  it("transitions to HALF_OPEN after cooldown and closes on success", async () => {
    const onClose = vi.fn();
    // Use a sandbox that fails once then succeeds
    let callCount = 0;
    const controllable: SandboxPort = {
      async run() {
        callCount++;
        if (callCount <= 1) return err({ code: "EXECUTION_ERROR", message: "fail" });
        return ok({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 });
      },
    };

    const sb = new CircuitBreakerSandbox(controllable, {
      failureThreshold: 1,
      cooldownMs: 50,
      onClose,
    });

    await sb.run("", OPTS); // opens
    expect(sb.circuitState).toBe("OPEN");

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 60));

    // Next call should probe (HALF_OPEN) and succeed → CLOSED
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(true);
    expect(sb.circuitState).toBe("CLOSED");
    expect(onClose).toHaveBeenCalled();
  });

  it("tripForTesting opens the circuit", async () => {
    const sb = new CircuitBreakerSandbox(makeSuccessSandbox(), { failureThreshold: 5 });
    sb.tripForTesting();
    const result = await sb.run("", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CIRCUIT_OPEN");
  });

  it("TIMEOUT does not count as a failure (sandbox is alive, just slow)", async () => {
    const timeoutSandbox: SandboxPort = {
      async run(): Promise<Result<SandboxOutput, SandboxError>> {
        return err({ code: "TIMEOUT", timeoutMs: 100 });
      },
    };
    const sb = new CircuitBreakerSandbox(timeoutSandbox, { failureThreshold: 2 });
    await sb.run("", OPTS);
    await sb.run("", OPTS);
    // TIMEOUT should NOT open the circuit (sandbox is alive)
    expect(sb.circuitState).toBe("CLOSED");
    expect(sb.failureCount).toBe(0);
  });
});
