import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E golden paths (Phase 11).
 *
 * The suite runs against a dev server on an ISOLATED data root
 * (e2e/.tmp-data) — the webServer command wipes it, seeds the full demo
 * dataset, then boots `npm run dev` on its own port, so a developer's
 * ./data store and 5173 server are never touched. Tests run serially in
 * one worker: the specs are ordered golden paths that intentionally
 * mutate governed state (packet resolution, ownership, comments).
 */

const E2E_PORT = 5177;
const E2E_DATA_ROOT = path.resolve(import.meta.dirname, "e2e/.tmp-data");

// Test-only secrets (deterministic; never used outside the e2e sandbox).
const E2E_ENV = {
  PORT: String(E2E_PORT),
  NODE_ENV: "development",
  BETTER_AUTH_URL: `http://localhost:${E2E_PORT}`,
  VIBERR_DATA_ROOT: E2E_DATA_ROOT,
  VIBERR_SESSION_SECRET: "e2e-session-secret-0123456789abcdefghijklmnop",
  // base64 of 32 bytes (0x00 * 32) — fine for an ephemeral test store.
  VIBERR_SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  // Belt and braces: if the server boots before the demo seed lands, the
  // bootstrap admin still gets the well-known dev password.
  VIBERR_SEED_ADMIN_EMAIL: "arda@viberr.dev",
  VIBERR_SEED_ADMIN_PASSWORD: "viberr-dev-2828",
  // Force the DETERMINISTIC simulated/scripted engine for e2e. Emptying the
  // credential vars isn't enough (dotenv re-loads a developer's `.env`), so use
  // the explicit runtime override — the golden-path specs assert on the
  // synchronous scripted operator, not live non-deterministic agent runs.
  VIBERR_FORCE_SIMULATED_RUNTIME: "1",
  // E2E-only exact GitHub observations for impossible fixture PR numbers.
  // Product code still uses its normal client; this Node preload replaces
  // transport only inside Playwright's isolated web-server process.
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--import=${path.resolve(import.meta.dirname, "e2e/github-fetch-fixture.mjs")}`,
  ]
    .filter(Boolean)
    .join(" "),
};

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
    // "localhost", not 127.0.0.1 — the Vite dev server may bind IPv6 ::1.
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
  },

  globalTeardown: "./e2e/global-teardown.ts",

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

  webServer: {
    // Fresh store every run: wipe → seed demo dataset → dev server.
    command:
      "rm -rf e2e/.tmp-data && npm run seed && tsx e2e/setup-fixtures.ts && npm run dev",
    url: `http://localhost:${E2E_PORT}/resources/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: E2E_ENV,
  },
});
