/**
 * Security test suite for WorkerThreadSandbox.
 *
 * Every test here represents a real attack vector or misuse scenario. Each must:
 *   - Be blocked and return a structured error (never crash the process)
 *   - Not hang the test (all have hard timeouts)
 *
 * These tests are the "negative path" equivalents of unit tests — they exist
 * to prove that isolation holds, not just that the happy path works.
 */
import { describe, expect, it } from "vitest";
import { WorkerThreadSandbox } from "../worker-thread-sandbox.js";

const sandbox = new WorkerThreadSandbox();

const OPTS = {
  timeoutMs: 1000,
  memoryMb: 64,
  allowedModules: [] as readonly string[],
  network: false as const,
};

describe("WorkerThreadSandbox — security", () => {
  it("blocks require('fs') with MODULE_NOT_ALLOWED", async () => {
    const result = await sandbox.run("require('fs')", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODULE_NOT_ALLOWED");
      if (result.error.code === "MODULE_NOT_ALLOWED") {
        expect(result.error.module).toBe("fs");
        expect(result.error.allowedModules).toEqual([]);
      }
    }
  });

  it("blocks require('child_process') with MODULE_NOT_ALLOWED", async () => {
    const result = await sandbox.run("require('child_process')", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODULE_NOT_ALLOWED");
    }
  });

  it("blocks require('net') with MODULE_NOT_ALLOWED", async () => {
    const result = await sandbox.run("require('net')", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODULE_NOT_ALLOWED");
    }
  });

  it("blocks require('http') with MODULE_NOT_ALLOWED", async () => {
    const result = await sandbox.run("require('http')", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODULE_NOT_ALLOWED");
    }
  });

  it("process.exit() does not kill the worker process — returns EXECUTION_ERROR", async () => {
    const result = await sandbox.run("process.exit(0)", OPTS);
    // process.exit is intercepted in the VM context and throws an error
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["EXECUTION_ERROR", "TIMEOUT"]).toContain(result.error.code);
    }
  });

  it("infinite loop is terminated by timeout — returns TIMEOUT", async () => {
    const result = await sandbox.run("while(true){}", {
      ...OPTS,
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  }, 5000);

  it("syntax error returns SYNTAX_ERROR with line number", async () => {
    const result = await sandbox.run("const x = {;", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SYNTAX_ERROR");
      if (result.error.code === "SYNTAX_ERROR") {
        expect(typeof result.error.line).toBe("number");
        expect(typeof result.error.message).toBe("string");
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("runtime error returns EXECUTION_ERROR with message", async () => {
    const result = await sandbox.run("throw new Error('boom')", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      if (result.error.code === "EXECUTION_ERROR") {
        expect(result.error.message).toContain("boom");
      }
    }
  });

  it("accessing fetch is blocked (ReferenceError caught as EXECUTION_ERROR)", async () => {
    const result = await sandbox.run("fetch('http://example.com')", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["EXECUTION_ERROR", "MODULE_NOT_ALLOWED"]).toContain(result.error.code);
    }
  });

  it("accessing XMLHttpRequest is blocked", async () => {
    const result = await sandbox.run("new XMLHttpRequest()", OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
    }
  });

  it("MODULE_NOT_ALLOWED error includes the allowedModules list", async () => {
    const optsWithMath = { ...OPTS, allowedModules: ["path"] as const };
    const result = await sandbox.run("require('os')", optsWithMath);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "MODULE_NOT_ALLOWED") {
      expect(result.error.allowedModules).toContain("path");
    }
  });

  it("allowed module can be required", async () => {
    const optsWithPath = { ...OPTS, allowedModules: ["path"] as const };
    const result = await sandbox.run(
      "const p = require('path'); console.log(p.join('a','b'));",
      optsWithPath,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout).toContain("a");
    }
  });

  it("main process remains alive after worker timeout", async () => {
    // Run a timeout-inducing script; the main process must still be running after
    await sandbox.run("while(true){}", { ...OPTS, timeoutMs: 200 });
    // If we reach this line, the main process survived
    expect(true).toBe(true);
  }, 5000);

  it("main process remains alive after worker crash (throw)", async () => {
    await sandbox.run("throw new Error('crash')", OPTS);
    expect(true).toBe(true);
  });

  it("stdout and stderr are captured correctly", async () => {
    const result = await sandbox.run("console.log('hello'); console.error('err');", OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout).toContain("hello");
      expect(result.value.stderr).toContain("err");
    }
  });

  it("durationMs is measured", async () => {
    const result = await sandbox.run("console.log('ok')", OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
