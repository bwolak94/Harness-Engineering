import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { EvalReport, EvalResult } from "./types.js";

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

/**
 * Build an EvalReport from a list of results, adding git metadata.
 */
export function buildReport(results: EvalResult[]): EvalReport {
  const passed = results.filter((r) => r.passed).length;

  // p95 duration
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const p95Index = Math.floor(durations.length * 0.95);
  const p95DurationMs = durations[p95Index] ?? durations.at(-1) ?? 0;

  const avgSteps =
    results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.steps, 0) / results.length;

  return {
    runAt: new Date().toISOString(),
    branch: gitBranch(),
    commit: gitCommit(),
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    successRate: results.length === 0 ? 0 : passed / results.length,
    avgSteps: Math.round(avgSteps * 100) / 100,
    p95DurationMs,
    results,
  };
}

/** Serialize the report to JSON (pretty-printed). */
export function toJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

/** Render the report as a GitHub-flavoured markdown summary. */
export function toMarkdown(report: EvalReport): string {
  const pct = (report.successRate * 100).toFixed(1);
  const statusIcon = report.failed === 0 ? "✅" : "❌";

  const lines: string[] = [
    `# Harness Eval Report ${statusIcon}`,
    "",
    `**Branch:** \`${report.branch}\`  **Commit:** \`${report.commit}\`  **Run at:** ${report.runAt}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Cases | ${report.totalCases} |`,
    `| Passed | ${report.passed} |`,
    `| Failed | ${report.failed} |`,
    `| Success rate | ${pct}% |`,
    `| Avg steps | ${report.avgSteps} |`,
    `| p95 duration | ${report.p95DurationMs} ms |`,
    "",
  ];

  if (report.failed > 0) {
    lines.push("## Failures", "");
    for (const r of report.results.filter((x) => !x.passed)) {
      lines.push(`### ❌ \`${r.caseId}\` — ${r.tool}`);
      lines.push(`> ${r.description}`, "");

      if (r.outcomeFailures.length > 0) {
        lines.push("**Outcome failures:**", "");
        for (const f of r.outcomeFailures) {
          lines.push(`- ${f.message}`);
        }
        lines.push("");
      }

      if (r.trajectoryFailures.length > 0) {
        lines.push("**Trajectory failures:**", "");
        for (const f of r.trajectoryFailures) {
          lines.push(`- ${f.message}`);
        }
        lines.push("");
      }

      if (r.snapshotDiff) {
        lines.push("**Snapshot diff:**", "");
        lines.push("```");
        lines.push(r.snapshotDiff);
        lines.push("```");
        lines.push("");
      }
    }
  }

  lines.push("## All Cases", "");
  lines.push("| Case ID | Tool | Status | Steps | Duration |");
  lines.push("|---------|------|--------|-------|----------|");
  for (const r of report.results) {
    const icon = r.passed ? "✅" : "❌";
    lines.push(
      `| \`${r.caseId}\` | ${r.tool} | ${icon} ${r.status} | ${r.steps} | ${r.durationMs} ms |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Write both report formats to the given output directory. */
export function writeReports(report: EvalReport, outputDir: string): void {
  writeFileSync(`${outputDir}/eval-report.json`, toJson(report), "utf8");
  writeFileSync(`${outputDir}/eval-report.md`, toMarkdown(report), "utf8");
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
