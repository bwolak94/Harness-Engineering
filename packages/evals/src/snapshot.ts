import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "@harness/contracts";

// Snapshots live next to the golden cases so they are committed to the repo
// and reviewed like any other code change.
const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden", "snapshots");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the ordered list of event type strings from a run.
 * This sequence is what we snapshot — it captures the runtime structure
 * without coupling to unstable IDs or timestamps.
 */
export function toEventTypeSequence(events: readonly HarnessEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Persist a snapshot for the given case ID (overwrites if it exists). */
export function saveSnapshot(caseId: string, sequence: string[]): void {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const path = snapshotPath(caseId);
  writeFileSync(path, JSON.stringify(sequence, null, 2), "utf8");
}

/**
 * Load a persisted snapshot.
 * Returns null when the snapshot file does not exist yet (first run).
 */
export function loadSnapshot(caseId: string): string[] | null {
  const path = snapshotPath(caseId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as string[];
}

/**
 * Compare actual against expected event-type sequence.
 * Returns a human-readable diff string, or null when they match.
 */
export function diffSnapshots(expected: string[], actual: string[]): string | null {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return null;

  const lines: string[] = ["Snapshot mismatch:"];

  const maxLen = Math.max(expected.length, actual.length);
  for (let i = 0; i < maxLen; i++) {
    const exp = expected[i] ?? "(missing)";
    const act = actual[i] ?? "(missing)";
    if (exp !== act) {
      lines.push(`  [${i}] expected: ${exp}`);
      lines.push(`  [${i}] actual:   ${act}`);
    }
  }

  if (expected.length !== actual.length) {
    lines.push(`  length: expected ${expected.length}, got ${actual.length}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function snapshotPath(caseId: string): string {
  return join(SNAPSHOTS_DIR, `${caseId}.json`);
}
