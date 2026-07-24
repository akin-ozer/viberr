import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SEED_DEFAULT_PASSWORD } from "./app/server/seed/seed-credentials";

/**
 * E2E golden paths (Phase 11).
 *
 * The suite runs against a dev server on an ISOLATED data root
 * (e2e/.tmp-data) — the webServer command wipes it, seeds the full demo
 * dataset, then boots `npm run dev` on its own port, so a developer's
 * ./data store and 5173 server are never touched.
 *
 * Scope: these specs READ seeded state and exercise UI-owned mutations
 * (theme cookie, mark-all-read, a real file-store mkdir). The specs that
 * drove agent runs and packet resolution went with the simulated runtime;
 * what is left needs no agent backend, so each spec stands alone rather
 * than depending on an earlier one having mutated governed state. Still
 * one worker, since they share the seeded store.
 */

const E2E_PORT = 5177;
const E2E_DATA_ROOT = path.resolve(import.meta.dirname, "e2e/.tmp-data");

// Test-only secrets (deterministic; never used outside the e2e sandbox).
const E2E_ENV = {
  PORT: String(E2E_PORT),
  NODE_ENV: "development",
  VIBERR_DATA_ROOT: E2E_DATA_ROOT,
  VIBERR_SESSION_SECRET: "e2e-session-secret-0123456789abcdefghijklmnop",
  // base64 of 32 bytes (0x00 * 32) — fine for an ephemeral test store.
  VIBERR_SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  // The webServer command is strictly sequential (seed:demo THEN dev), so the
  // server never boots before the seed — by boot time users exist and
  // seedInitialAdmin no-ops. These vars just pin the bootstrap admin to the
  // same well-known credentials the demo seed and e2e login use, keeping them
  // consistent if the seed ever stops running first. Password is the single
  // SEED_DEFAULT_PASSWORD constant so it can never drift from the seed.
  VIBERR_SEED_ADMIN_EMAIL: "arda@viberr.dev",
  VIBERR_SEED_ADMIN_PASSWORD: SEED_DEFAULT_PASSWORD,
  // NOTE: this config used to force the simulated/scripted runtime here. That
  // engine is gone, and with it the two specs that drove agent runs (02-packet,
  // 04-runtime). The remaining specs never start a run, so the server boots
  // with no agent credential and any run would simply report unavailable.
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
    // Fresh store every run: wipe → seed the DEMO FIXTURE → dev server. The
    // specs are written against the mock dataset, which the product seed no
    // longer ships (clean-sheet ruling) — seed:demo is the test/dev-only
    // fixture seeder (scripts/seed-demo.ts → test-support/demo-seed.ts).
    command: "rm -rf e2e/.tmp-data && npm run seed:demo && npm run dev",
    url: `http://localhost:${E2E_PORT}/resources/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: E2E_ENV,
  },
});
