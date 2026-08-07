/**
 * LoopDetector — hash-based repetition detection for agent tool calls.
 *
 * Hashes (toolName, normalised args) and counts invocations per unique hash.
 * At the threshold, it returns a corrective message to be injected into the
 * conversation rather than hard-stopping execution.
 *
 * Rationale for "inject, don't stop":
 *   A hard stop at the 3rd repeat destroys information — the model never
 *   learns why it was halted. Injecting a corrective message gives the model
 *   an opportunity to course-correct (e.g., change arguments or switch tools).
 *   The budget enforcer is the safety net for truly stuck loops.
 */
export class LoopDetector {
  private readonly counts = new Map<string, number>();
  private readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  /**
   * Record a tool invocation.
   *
   * Returns a corrective message string if the invocation count for this
   * (toolName, args) pair has reached the threshold, or null otherwise.
   * The message is intentionally written for the model, not for a human log.
   */
  record(toolName: string, args: unknown): string | null {
    const hash = this.buildHash(toolName, args);
    const count = (this.counts.get(hash) ?? 0) + 1;
    this.counts.set(hash, count);

    if (count >= this.threshold) {
      return `[HARNESS] You have called '${toolName}' with the same arguments ${count} time(s). Repeating this call is unlikely to produce different results. Consider using a different tool, adjusting the arguments, or summarising what you have learned so far before proceeding.`;
    }
    return null;
  }

  /** Reset all counters (e.g., when resuming a workflow after suspension). */
  reset(): void {
    this.counts.clear();
  }

  /** Current invocation count for a given (toolName, args) pair. */
  getCount(toolName: string, args: unknown): number {
    return this.counts.get(this.buildHash(toolName, args)) ?? 0;
  }

  /**
   * Build a stable hash string from toolName + normalised args.
   * Args are normalised by sorting object keys so {a:1, b:2} equals {b:2, a:1}.
   */
  private buildHash(toolName: string, args: unknown): string {
    return `${toolName}:${JSON.stringify(normaliseValue(args))}`;
  }
}

function normaliseValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normaliseValue);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = normaliseValue(obj[key]);
  }
  return sorted;
}
