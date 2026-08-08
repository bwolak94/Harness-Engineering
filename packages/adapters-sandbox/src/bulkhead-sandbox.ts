import type { Result } from "@harness/core";
import type { SandboxError, SandboxOptions, SandboxOutput, SandboxPort } from "@harness/core";

/**
 * BulkheadSandbox — limits concurrent sandbox executions.
 *
 * Pattern: Bulkhead (named after ship compartments that contain flooding).
 * A fixed number of active workers runs concurrently. Requests that arrive
 * while the pool is full are queued up to `queueSize`. Requests that arrive
 * while the queue is also full are immediately rejected with POOL_EXHAUSTED.
 *
 * This prevents a wave of compute-heavy code submissions from starving the
 * rest of the server — each running worker has a hard memory limit, so
 * `poolSize * memoryMb` is the worst-case sandbox footprint.
 */
export class BulkheadSandbox implements SandboxPort {
  private readonly inner: SandboxPort;
  private readonly poolSize: number;
  private readonly queueSize: number;

  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(inner: SandboxPort, poolSize = 4, queueSize = 16) {
    this.inner = inner;
    this.poolSize = poolSize;
    this.queueSize = queueSize;
  }

  async run(code: string, opts: SandboxOptions): Promise<Result<SandboxOutput, SandboxError>> {
    if (this.active < this.poolSize) {
      // Fast path: capacity available, run immediately
      return this.execute(code, opts);
    }

    if (this.queue.length >= this.queueSize) {
      // Queue is also full — reject
      return {
        ok: false,
        error: { code: "POOL_EXHAUSTED", queueLength: this.queue.length },
      };
    }

    // Enqueue and wait for a slot
    return new Promise<Result<SandboxOutput, SandboxError>>((resolve) => {
      this.queue.push(() => {
        this.execute(code, opts)
          .then(resolve)
          .catch((err: unknown) => {
            resolve({
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          });
      });
    });
  }

  private async execute(
    code: string,
    opts: SandboxOptions,
  ): Promise<Result<SandboxOutput, SandboxError>> {
    this.active++;
    try {
      return await this.inner.run(code, opts);
    } finally {
      this.active--;
      // Promote next queued request
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Visible for testing. */
  get activeCount(): number {
    return this.active;
  }

  /** Visible for testing. */
  get queueLength(): number {
    return this.queue.length;
  }
}
