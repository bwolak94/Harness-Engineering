import type { ClockPort } from "@harness/core";

/**
 * FixedClock — a deterministic clock that always returns the same timestamp.
 *
 * Used in tests to guarantee reproducible event timestamps. Without a fixed
 * clock, snapshot comparisons would fail on every run due to changing timestamps.
 *
 * Can be advanced manually via advance() for tests that need to simulate elapsed time.
 */
export class FixedClock implements ClockPort {
  private currentMs: number;

  constructor(epochMs = 0) {
    this.currentMs = epochMs;
  }

  now(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  /** Advance the clock by the given number of milliseconds. */
  advance(ms: number): void {
    this.currentMs += ms;
  }

  /** Set the clock to a specific epoch timestamp. */
  set(epochMs: number): void {
    this.currentMs = epochMs;
  }
}
