import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration.
 *
 * Tests run against a locally running dev server (apps/web + apps/server).
 * In CI the server is started as a separate Docker service; locally use:
 *   pnpm dev          # start the frontend at http://localhost:5173
 *   pnpm --filter @harness/server dev  # start the backend at http://localhost:3000
 *
 * Set PLAYWRIGHT_BASE_URL to override the frontend origin.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // In CI: do NOT start a dev server — the server is managed externally.
  // Locally: un-comment the webServer block to auto-start:
  // webServer: {
  //   command: "pnpm dev",
  //   url: "http://localhost:5173",
  //   reuseExistingServer: true,
  // },
});
