import { Worker } from "node:worker_threads";
import type { Result } from "@harness/core";
import type { SandboxError, SandboxOptions, SandboxOutput, SandboxPort } from "@harness/core";

/**
 * WorkerThreadSandbox — isolates user code in a Node.js worker thread.
 *
 * Isolation layers:
 *   1. Worker thread:   crash/OOM in worker cannot kill the main process
 *   2. node:vm context: no access to Node.js globals (require, process, Buffer)
 *   3. Resource limits: maxOldGenerationSizeMb via V8 heap limit
 *   4. Hard timeout:    parent terminates the worker if it doesn't respond in time
 *   5. Module allowlist: custom require stub in the VM context; unrecognised
 *      modules throw MODULE_NOT_ALLOWED with the allowlist shown
 *
 * The worker code is embedded as an inline string (eval: true) to avoid file
 * path resolution issues between compiled dist/ and test source trees.
 *
 * Concurrency: each `run()` call spawns a new worker. Use BulkheadSandbox
 * to limit concurrent workers in production.
 */
export class WorkerThreadSandbox implements SandboxPort {
  async run(code: string, opts: SandboxOptions): Promise<Result<SandboxOutput, SandboxError>> {
    const { timeoutMs, memoryMb, allowedModules, signal } = opts;

    // Short-circuit if the caller already cancelled
    if (signal?.aborted) {
      return {
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "Execution cancelled before start" },
      };
    }

    return new Promise<Result<SandboxOutput, SandboxError>>((resolve) => {
      const startMs = Date.now();
      let settled = false;

      function settle(result: Result<SandboxOutput, SandboxError>): void {
        if (settled) return;
        settled = true;
        clearTimeout(hardDeadline);
        resolve(result);
      }

      const worker = new Worker(WORKER_SCRIPT, {
        eval: true,
        workerData: {
          code,
          allowedModules: [...allowedModules],
          timeoutMs,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: memoryMb,
        },
      });

      // Hard deadline: terminate if the worker hangs beyond the timeout.
      // Adds 200 ms buffer so the vm-internal timeout fires first (giving a
      // cleaner TIMEOUT message instead of a generic worker exit event).
      const hardDeadline = setTimeout(() => {
        void worker.terminate();
        settle({
          ok: false,
          error: { code: "TIMEOUT", timeoutMs },
        });
      }, timeoutMs + 200);

      // Cooperative cancellation via AbortSignal
      signal?.addEventListener("abort", () => {
        void worker.terminate();
        settle({
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "Execution cancelled by caller" },
        });
      });

      worker.on("message", (msg: WorkerResult) => {
        void worker.terminate();
        const durationMs = Date.now() - startMs;

        if (msg.ok) {
          settle({
            ok: true,
            value: {
              stdout: msg.stdout,
              stderr: msg.stderr,
              exitCode: 0,
              durationMs,
            },
          });
        } else {
          settle({ ok: false, error: workerErrorToSandboxError(msg, timeoutMs, memoryMb) });
        }
      });

      worker.on("error", (err) => {
        const durationMs = Date.now() - startMs;

        // V8 heap limit exceeded → ERR_WORKER_OUT_OF_MEMORY
        if ((err as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY") {
          settle({ ok: false, error: { code: "MEMORY_LIMIT_EXCEEDED", memoryMb } });
        } else {
          settle({
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: err.message,
            },
          });
        }

        void durationMs; // consumed via startMs above
      });

      worker.on("exit", (code) => {
        // Only fires if worker exits without posting a message (OOM, terminate)
        // Worker.terminate() exits with code 1
        if (code !== 0 && !settled) {
          settle({
            ok: false,
            error: { code: "EXECUTION_ERROR", message: `Worker exited with code ${code}` },
          });
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Worker script (embedded — eval: true, runs as CommonJS in the worker thread)
// ---------------------------------------------------------------------------

/**
 * The worker executes user code in a vm.createContext() with a restricted
 * set of globals. Network and file-system access are unavailable because
 * require is replaced by a stub that enforces the allowlist, and no
 * globals like fetch, XMLHttpRequest, or fs are provided.
 *
 * process.exit() is intercepted in the VM context and throws instead of
 * terminating the worker (which would terminate the whole thread cleanly
 * and give an incomplete result rather than an error message).
 */
const WORKER_SCRIPT = /* javascript */ `
const { workerData, parentPort } = require('worker_threads');
const vm = require('vm');

const { code, allowedModules, timeoutMs } = workerData;

// Module allowlist — only permitted modules may be required
function makeSandboxRequire(allowed) {
  return function sandboxRequire(id) {
    if (!allowed.includes(id)) {
      const err = new Error(
        "Module '" + id + "' is not allowed in the sandbox. " +
        (allowed.length > 0 ? "Allowed: " + allowed.join(', ') : "No modules are allowed.")
      );
      err.__sandboxModuleNotAllowed = id;
      throw err;
    }
    return require(id);
  };
}

const capturedStdout = [];
const capturedStderr = [];

function stringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

const sandbox = vm.createContext({
  console: {
    log:   (...args) => capturedStdout.push(args.map(stringify).join(' ')),
    error: (...args) => capturedStderr.push(args.map(stringify).join(' ')),
    warn:  (...args) => capturedStderr.push(args.map(stringify).join(' ')),
    info:  (...args) => capturedStdout.push(args.map(stringify).join(' ')),
  },
  require: makeSandboxRequire(allowedModules || []),
  process: {
    env: {},
    argv: [],
    version: process.version,
    exit: function() {
      throw new Error('process.exit() is not allowed in the sandbox');
    },
  },
  // Explicitly block timers and network — they are not provided in the context
  // so accessing them throws ReferenceError, which is caught below.
  Math: Math,
  JSON: JSON,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  isFinite: isFinite,
  Array: Array,
  Object: Object,
  String: String,
  Number: Number,
  Boolean: Boolean,
  RegExp: RegExp,
  Date: Date,
  Error: Error,
  TypeError: TypeError,
  RangeError: RangeError,
  Map: Map,
  Set: Set,
  Promise: Promise,
  Symbol: Symbol,
  BigInt: BigInt,
  Infinity: Infinity,
  NaN: NaN,
  undefined: undefined,
  null: null,
});

try {
  const script = new vm.Script(code, { filename: 'sandbox.js' });
  script.runInContext(sandbox, { timeout: timeoutMs });
  parentPort.postMessage({
    ok: true,
    stdout: capturedStdout.join('\\n'),
    stderr: capturedStderr.join('\\n'),
  });
} catch (err) {
  if (err.__sandboxModuleNotAllowed) {
    parentPort.postMessage({
      ok: false,
      errorCode: 'MODULE_NOT_ALLOWED',
      module: err.__sandboxModuleNotAllowed,
      allowedModules: allowedModules || [],
    });
  } else if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
             (err.message && err.message.includes('Script execution timed out'))) {
    parentPort.postMessage({ ok: false, errorCode: 'TIMEOUT' });
  } else if (err instanceof SyntaxError || err.name === 'SyntaxError') {
    // Extract line number from vm error message format: "sandbox.js:N"
    const match = err.stack && err.stack.match(/sandbox\\.js:(\\d+)/);
    parentPort.postMessage({
      ok: false,
      errorCode: 'SYNTAX_ERROR',
      line: match ? parseInt(match[1], 10) : 0,
      column: 0,
      message: err.message,
    });
  } else {
    parentPort.postMessage({
      ok: false,
      errorCode: 'EXECUTION_ERROR',
      message: err.message || String(err),
    });
  }
}
`;

// ---------------------------------------------------------------------------
// Internal types for worker message protocol
// ---------------------------------------------------------------------------

type WorkerResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; errorCode: "TIMEOUT" }
  | { ok: false; errorCode: "MODULE_NOT_ALLOWED"; module: string; allowedModules: string[] }
  | { ok: false; errorCode: "SYNTAX_ERROR"; line: number; column: number; message: string }
  | { ok: false; errorCode: "EXECUTION_ERROR"; message: string };

// memoryMb is handled by the worker 'error' event (ERR_WORKER_OUT_OF_MEMORY), not by the message.
function workerErrorToSandboxError(
  msg: Extract<WorkerResult, { ok: false }>,
  timeoutMs: number,
  _memoryMb: number,
): SandboxError {
  switch (msg.errorCode) {
    case "TIMEOUT":
      return { code: "TIMEOUT", timeoutMs };
    case "MODULE_NOT_ALLOWED":
      return { code: "MODULE_NOT_ALLOWED", module: msg.module, allowedModules: msg.allowedModules };
    case "SYNTAX_ERROR":
      return { code: "SYNTAX_ERROR", line: msg.line, column: msg.column, message: msg.message };
    default:
      return { code: "EXECUTION_ERROR", message: msg.message };
  }
}
