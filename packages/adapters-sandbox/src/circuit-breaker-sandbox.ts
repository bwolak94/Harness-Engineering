import type { Result } from "@harness/core";
import type { SandboxError, SandboxOptions, SandboxOutput, SandboxPort } from "@harness/core";

/**
 * CircuitBreakerSandbox — stops calling the inner sandbox after repeated failures.
 *
 * Pattern: Circuit Breaker (Fowler, "Release It!").
 *
 * States:
 *   CLOSED    — normal operation; consecutive failures are counted.
 *   OPEN      — inner sandbox is not called; all requests immediately return
 *               CIRCUIT_OPEN. Stays open for `cooldownMs` after the last failure.
 *   HALF_OPEN — one probe request is allowed after cooldown expires.
 *               Success → CLOSED; failure → OPEN (cooldown restarted).
 *
 * "Failure" definition: any SandboxError result. Successful results (ok: true)
 * or TIMEOUT errors reset the consecutive-failure counter (timeout means the
 * sandbox is alive, just slow — not a reason to open the circuit).
 *
 * An `onOpen` callback can be used to emit a HarnessEvent so the circuit-open
 * state is visible in the inspector.
 */
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the circuit opens. Default: 5. */
  failureThreshold?: number;
  /** Milliseconds to wait before probing again after the circuit opens. Default: 10 000. */
  cooldownMs?: number;
  /** Called when the circuit transitions to OPEN. */
  onOpen?: (failureCount: number) => void;
  /** Called when the circuit transitions back to CLOSED. */
  onClose?: () => void;
}

export class CircuitBreakerSandbox implements SandboxPort {
  private readonly inner: SandboxPort;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly onOpen?: (failureCount: number) => void;
  private readonly onClose?: () => void;

  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(inner: SandboxPort, opts: CircuitBreakerOptions = {}) {
    this.inner = inner;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 10_000;
    if (opts.onOpen !== undefined) this.onOpen = opts.onOpen;
    if (opts.onClose !== undefined) this.onClose = opts.onClose;
  }

  async run(code: string, opts: SandboxOptions): Promise<Result<SandboxOutput, SandboxError>> {
    // Transition OPEN → HALF_OPEN if cooldown has elapsed
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "HALF_OPEN";
      } else {
        return {
          ok: false,
          error: {
            code: "CIRCUIT_OPEN",
            failureCount: this.consecutiveFailures,
            cooldownMs: this.cooldownMs - (Date.now() - this.openedAt),
          },
        };
      }
    }

    // In HALF_OPEN, only one probe is in flight at a time
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenInFlight) {
        return {
          ok: false,
          error: {
            code: "CIRCUIT_OPEN",
            failureCount: this.consecutiveFailures,
            cooldownMs: 0,
          },
        };
      }
      this.halfOpenInFlight = true;
    }

    try {
      const result = await this.inner.run(code, opts);

      if (result.ok || result.error.code === "TIMEOUT") {
        // Success or timeout — the sandbox is alive; reset the failure counter
        this.onSuccess();
      } else {
        this.onFailure();
      }

      return result;
    } catch (err) {
      this.onFailure();
      return {
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    } finally {
      this.halfOpenInFlight = false;
    }
  }

  private onSuccess(): void {
    const wasOpen = this.state !== "CLOSED";
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    if (wasOpen) this.onClose?.();
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      this.onOpen?.(this.consecutiveFailures);
    }
  }

  /** Visible for testing. */
  get circuitState(): CircuitState {
    return this.state;
  }

  /** Visible for testing. */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  /** Force the circuit open — useful for testing downstream behaviour. */
  tripForTesting(): void {
    this.state = "OPEN";
    this.consecutiveFailures = this.failureThreshold;
    this.openedAt = Date.now();
  }
}
