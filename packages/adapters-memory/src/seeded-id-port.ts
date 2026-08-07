import type { IdPort } from "@harness/core";

/**
 * SeededIdPort — a deterministic ID generator for testing.
 *
 * Returns IDs in the format `<prefix>-<n>` where n is a monotonically
 * increasing counter. Using a SeededIdPort in tests makes event sequences
 * fully deterministic and comparable via snapshot assertions.
 *
 * Example:
 *   const ids = new SeededIdPort("id");
 *   ids.newId(); // "id-1"
 *   ids.newId(); // "id-2"
 */
export class SeededIdPort implements IdPort {
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix = "id") {
    this.prefix = prefix;
  }

  newId(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }

  /** Reset the counter — useful between test cases. */
  reset(): void {
    this.counter = 0;
  }

  /** Peek at the current counter without incrementing. */
  peek(): number {
    return this.counter;
  }
}
