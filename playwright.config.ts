import { defineConfig, devices } from "@playwright/test";

/**
 * E2E golden paths.
 *
 * The suite runs against the PRODUCTION Docker image in an isolated Compose
 * stack (owner policy, 2026-08-02 — never a dev server). `npm run e2e` drives
 * scripts/e2e.ts, which seeds the demo fixture onto a fresh named volume,
 * boots the final-stage image, waits for /resources/health, and exports the
 * derived base URL as VIBERR_E2E_BASE_URL before invoking Playwright.
 *
 * Scope: these specs READ seeded state and exercise UI-owned mutations
 * (theme cookie, mark-all-read, comments, board moves, epics). Still one
 * worker, since they share the seeded store.
 */

const baseURL = process.env.VIBERR_E2E_BASE_URL;
if (!baseURL) {
  throw new Error(
    "VIBERR_E2E_BASE_URL is not set. Run the suite through `npm run e2e` " +
      "(scripts/e2e.ts) — it boots the isolated production-image Compose " +
      "stack and derives the base URL. A bare `npx playwright test` has no " +
      "app to target.",
  );
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
  },

  projects: [
    // Logs in once through the real /login UI and stores the session.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/arda.json",
      },
      dependencies: ["setup"],
    },
  ],
});
