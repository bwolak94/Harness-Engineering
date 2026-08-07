// @vitest-environment node
/**
 * FSD boundary enforcement — static import analysis.
 *
 * Rule: a layer may only import from layers below it.
 * Forbidden: features → widgets, features → pages, features → app
 *            entities → features, entities → widgets, entities → pages, entities → app
 *            shared → anything above it
 *
 * DoD item: "Lint FSD blokuje import features → widgets (pokaż output)"
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src", import.meta.url).pathname;

function collectFiles(dir: string, ext = /\.(ts|tsx)$/): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, ext));
    } else if (ext.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function extractImports(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const matches = [...content.matchAll(/from\s+["']([^"']+)["']/g)];
  return matches.map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// Layer directories and their forbidden upper-layer imports
// ---------------------------------------------------------------------------

const FORBIDDEN_IMPORTS: Array<{ layer: string; bannedSegments: string[] }> = [
  {
    layer: "features",
    bannedSegments: ["widgets", "pages", "app"],
  },
  {
    layer: "entities",
    bannedSegments: ["features", "widgets", "pages", "app"],
  },
  {
    layer: "shared",
    bannedSegments: ["entities", "features", "widgets", "pages", "app"],
  },
];

describe("FSD layer boundaries", () => {
  for (const { layer, bannedSegments } of FORBIDDEN_IMPORTS) {
    const layerDir = join(SRC, layer);
    let files: string[] = [];
    try {
      files = collectFiles(layerDir);
    } catch {
      // Layer directory may not yet exist — skip gracefully.
    }

    if (files.length === 0) continue;

    it(`${layer} must not import from: ${bannedSegments.join(", ")}`, () => {
      const violations: string[] = [];

      for (const file of files) {
        const imports = extractImports(file);
        for (const imp of imports) {
          // Relative imports: check if the path traverses into a banned layer.
          for (const banned of bannedSegments) {
            // Match patterns like ../../widgets/..., ../../../pages/..., etc.
            if (imp.includes(`/${banned}/`) || imp.endsWith(`/${banned}`)) {
              const rel = relative(SRC, file);
              violations.push(`  ${rel}\n    imports from "${banned}": ${imp}`);
            }
          }
        }
      }

      if (violations.length > 0) {
        console.error(
          `\nFSD violation: ${layer} → [${bannedSegments.join("|")}]\n${violations.join("\n")}\n`,
        );
      }

      expect(violations, `FSD boundary violated in layer "${layer}"`).toHaveLength(0);
    });
  }
});
