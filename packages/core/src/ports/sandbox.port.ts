import type { Result } from "../domain/result.js";

/**
 * SandboxPort — isolated code execution environment.
 *
 * Implementations must enforce:
 *   - No outbound network access (network: false is non-negotiable)
 *   - Module allowlist (only explicitly permitted modules may be imported)
 *   - Hard memory cap via resourceLimits or cgroup
 *   - Hard time cap that survives infinite loops
 *
 * The port returns Result<SandboxOutput, SandboxError> so the caller can
 * relay structured errors back to the model for self-correction — the same
 * contract used by every other tool in this harness.
 */
export interface SandboxPort {
  run(code: string, opts: SandboxOptions): Promise<Result<SandboxOutput, SandboxError>>;
}

export interface SandboxOptions {
  /** Wall-clock timeout for the entire execution, in milliseconds. */
  timeoutMs: number;
  /** Max heap size in megabytes (V8 old-generation limit). */
  memoryMb: number;
  /** Explicit allowlist of modules the sandbox may import. Empty = no modules. */
  allowedModules: readonly string[];
  /** Network is always disabled — the field exists to make the restriction visible. */
  network: false;
  /** Optional AbortSignal for cooperative cancellation from outside. */
  signal?: AbortSignal;
}

export interface SandboxOutput {
  stdout: string;
  stderr: string;
  /** Always 0 for successful execution in a vm sandbox (no real process exit). */
  exitCode: number;
  durationMs: number;
}

/** Discriminated union — each variant carries the data needed to self-correct. */
export type SandboxError =
  | { code: "TIMEOUT"; timeoutMs: number }
  | { code: "MEMORY_LIMIT_EXCEEDED"; memoryMb: number }
  | {
      code: "MODULE_NOT_ALLOWED";
      module: string;
      allowedModules: readonly string[];
    }
  | { code: "SYNTAX_ERROR"; line: number; column: number; message: string }
  | { code: "EXECUTION_ERROR"; message: string }
  | { code: "CIRCUIT_OPEN"; failureCount: number; cooldownMs: number }
  | { code: "POOL_EXHAUSTED"; queueLength: number };

/**
 * No-op sandbox — always returns EXECUTION_ERROR with a "not configured"
 * message. Used in environments where no real sandbox adapter is wired up,
 * so the model gets a helpful error instead of a crash.
 */
export class NoopSandbox implements SandboxPort {
  async run(_code: string, _opts: SandboxOptions): Promise<Result<SandboxOutput, SandboxError>> {
    return {
      ok: false,
      error: {
        code: "EXECUTION_ERROR",
        message:
          "Sandbox is not configured in this environment. " +
          "Use domain-specific calculation tools (analyzeInvestment, calculateLandedCost, etc.) instead.",
      },
    };
  }
}
