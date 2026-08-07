import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "core",
      include: ["packages/core/**/*.test.ts"],
      coverage: {
        provider: "v8",
        // harness-runtime.ts is an integration-only file — it requires real adapter
        // implementations to be testable and is covered by the adapters-memory suite.
        // Excluding it here keeps the 90% threshold meaningful for pure domain/ports.
        exclude: ["**/harness-runtime.ts"],
        thresholds: {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
  {
    test: {
      name: "contracts",
      include: ["packages/contracts/**/*.test.ts"],
      coverage: {
        provider: "v8",
        thresholds: {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
      },
    },
  },
  {
    test: {
      name: "adapters-memory",
      include: ["packages/adapters-memory/**/*.test.ts"],
      coverage: {
        provider: "v8",
        thresholds: {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
      },
    },
  },
  {
    test: {
      name: "adapters-postgres",
      include: ["packages/adapters-postgres/**/*.test.ts"],
      // Testcontainers (PostgreSQL) can take 30-60 s to start — raise the threshold.
      testTimeout: 180_000,
      hookTimeout: 120_000,
      coverage: {
        provider: "v8",
        thresholds: {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
      },
    },
  },
  {
    test: {
      name: "adapters-llm",
      include: ["packages/adapters-llm/**/*.test.ts"],
      coverage: {
        provider: "v8",
        thresholds: {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
      },
    },
  },
  {
    test: {
      name: "adapters-sandbox",
      include: ["packages/adapters-sandbox/**/*.test.ts"],
      coverage: {
        provider: "v8",
        thresholds: {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
      },
    },
  },
  {
    test: {
      name: "observability",
      include: ["packages/observability/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "server",
      include: ["apps/server/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "web",
      include: ["apps/web/**/*.test.ts"],
      environment: "jsdom",
    },
  },
]);
