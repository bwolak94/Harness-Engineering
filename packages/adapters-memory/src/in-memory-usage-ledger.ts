/**
 * InMemoryUsageLedger — in-process UsageLedgerPort for tests and local dev.
 *
 * Stores entries in an array (append-only). Idempotent on entry.id.
 */

import type { UsageLedgerEntry, UsageLedgerPort } from "@harness/core";

export class InMemoryUsageLedger implements UsageLedgerPort {
  private readonly entries: UsageLedgerEntry[] = [];
  private readonly seen = new Set<string>();

  async append(entries: UsageLedgerEntry[]): Promise<void> {
    for (const entry of entries) {
      if (!this.seen.has(entry.id)) {
        this.seen.add(entry.id);
        this.entries.push(entry);
      }
    }
  }

  /** Test helper — returns all recorded entries. */
  all(): UsageLedgerEntry[] {
    return [...this.entries];
  }

  /** Test helper — returns entries for a given tenant. */
  forTenant(tenantId: string): UsageLedgerEntry[] {
    return this.entries.filter((e) => e.tenantId === tenantId);
  }

  /** Test helper — total cost_usd across all entries. */
  totalCostUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  /** Test helper — clears all entries. */
  clear(): void {
    this.entries.length = 0;
    this.seen.clear();
  }
}
