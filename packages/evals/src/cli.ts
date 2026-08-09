#!/usr/bin/env node
/**
 * pnpm eval — Harness evaluation CLI.
 *
 * Usage:
 *   pnpm eval                        Run all golden cases, compare snapshots
 *   pnpm eval --update-snapshots     Regenerate snapshot files from current output
 *   pnpm eval --json                 Print JSON report to stdout (CI-friendly)
 *   pnpm eval --output <dir>         Write report files to <dir> (default: ./eval-output)
 *
 * Exit code: 0 if all cases pass, 1 if any fail.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_CASES } from "./golden/index.js";
import { buildReport, toMarkdown, writeReports } from "./report.js";
import { EvalRunner } from "./runner.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const updateSnapshots = args.includes("--update-snapshots");
const jsonMode = args.includes("--json");

const outputIndex = args.indexOf("--output");
const outputDir =
  outputIndex !== -1 && args[outputIndex + 1]
    ? (args[outputIndex + 1] as string)
    : join(process.cwd(), "eval-output");

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!jsonMode) {
    console.log(`\nRunning ${ALL_CASES.length} eval cases...`);
    if (updateSnapshots) {
      console.log("  --update-snapshots: snapshot files will be regenerated\n");
    }
  }

  const runner = new EvalRunner();
  const results = await runner.runAll(ALL_CASES, { updateSnapshots });

  const report = buildReport(results);

  if (jsonMode) {
    // Compact JSON to stdout for CI parsing
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    // Human-readable progress
    for (const r of results) {
      const icon = r.passed ? "✅" : "❌";
      console.log(`  ${icon} ${r.caseId.padEnd(40)} ${r.steps} steps  ${r.durationMs}ms`);
      if (!r.passed) {
        for (const f of r.outcomeFailures) {
          console.log(`     outcome: ${f.message}`);
        }
        for (const f of r.trajectoryFailures) {
          console.log(`     trajectory: ${f.message}`);
        }
        if (r.snapshotDiff) {
          console.log(
            `     snapshot:\n${r.snapshotDiff
              .split("\n")
              .map((l) => `       ${l}`)
              .join("\n")}`,
          );
        }
      }
    }

    const pct = (report.successRate * 100).toFixed(1);
    console.log(`\n${report.passed}/${report.totalCases} passed (${pct}%)`);
    console.log(`avg steps: ${report.avgSteps}  p95 duration: ${report.p95DurationMs}ms\n`);

    // Write report files
    mkdirSync(outputDir, { recursive: true });
    writeReports(report, outputDir);
    console.log(`Reports written to: ${outputDir}/`);
    console.log("  eval-report.json");
    console.log("  eval-report.md\n");

    if (!jsonMode) {
      console.log(
        toMarkdown(report).slice(0, 1000) + (toMarkdown(report).length > 1000 ? "..." : ""),
      );
    }
  }

  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("Eval harness crashed:", err);
  process.exit(1);
});
