/**
 * IdempotencyStorePort — key-value store for deduplicating tool executions.
 *
 * The key is `${workflowId}:${seq}:${toolName}` where seq is the seq number
 * of the tool.called event, making it unique and deterministic per execution.
 *
 * Pattern: Idempotency Key
 *   Converts at-least-once delivery (the only guarantee after a crash) into
 *   effectively-once execution. Without this, a resume after SIGKILL between
 *   execute and append(tool.succeeded) would re-run the tool a second time.
 */
export interface IdempotencyStorePort {
  /**
   * Retrieve a previously stored result.
   * Returns undefined if the key has never been set.
   */
  get(key: string): Promise<unknown | undefined>;

  /**
   * Persist the result for key. Subsequent get() calls with the same key
   * return this value instead of re-executing.
   * Implementations must be durable: the value must survive process restarts.
   */
  set(key: string, result: unknown): Promise<void>;
}

/**
 * Build a deterministic idempotency key for a tool call.
 * Using the seq of the tool.called event guarantees uniqueness within a
 * workflow without requiring hashing or additional storage.
 */
export function buildIdempotencyKey(workflowId: string, seq: number, toolName: string): string {
  return `${workflowId}:${seq}:${toolName}`;
}

/** No-op implementation — never caches. Useful in tests that don't need idempotency. */
export class NoopIdempotencyStore implements IdempotencyStorePort {
  async get(_key: string): Promise<undefined> {
    return undefined;
  }

  async set(_key: string, _result: unknown): Promise<void> {
    // intentionally empty
  }
}
