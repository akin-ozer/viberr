/**
 * Seeds the DEMO FIXTURE — the mock dataset (arda & co, viberr-core with
 * tasks VIB-139…168, stub projects, Arda's inbox) that the e2e specs and
 * route-level suites are written against, plus org resources.
 *
 * TEST/DEV ONLY. The product seed (`npm run seed`) is a clean sheet and
 * never ships this data; use this when you explicitly want the demo board
 * (Playwright does, via playwright.config.ts).
 *
 *   npm run seed:demo             — idempotent
 *   npm run seed:demo -- --reset  — wipe board + derived state first
 */
import { getEnv } from "../app/server/config/env.server";
import { getDb } from "../app/server/db/sqlite.server";
import { seedOrgResources } from "../app/server/org/org-seed.server";

// The demo fixture lives under test-support/, which the production Docker image
// deliberately does NOT ship (it would bloat the runtime with test code). Import
// it dynamically so a `seed:demo` attempt in that image fails with a clear
// "dev-only" message instead of a cryptic module-not-found (seed #2).
let runDemoSeed: typeof import("../test-support/demo-seed").runDemoSeed;
let SEED_DEFAULT_PASSWORD: string;
try {
  ({ runDemoSeed, SEED_DEFAULT_PASSWORD } = await import("../test-support/demo-seed"));
} catch {
  console.error(
    "`npm run seed:demo` is a TEST/DEV-only tool and needs the `test-support/` " +
      "fixtures, which are not shipped in the production image. Use `npm run seed` " +
      "(the clean-sheet product seed) instead.",
  );
  process.exit(1);
}

const env = getEnv();
const reset = process.argv.includes("--reset");

const summary = await runDemoSeed(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  reset,
  adminPassword: env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD,
});

const org = seedOrgResources(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  reset,
});

console.log(
  [
    "viberr DEMO fixture seeded (test/dev only — the product seed is a clean sheet):",
    `  users          ${summary.users}`,
    `  projects       ${summary.projects}`,
    `  tasks          ${summary.tasks}`,
    `  notifications  ${summary.notifications}`,
    `  agent profiles ${summary.agentProfiles}`,
    `  org kbs        ${org.kbs} (${org.kbFiles} files)`,
    `  org skills     ${org.skills}`,
    "",
    `Sign in: arda@viberr.dev / ${env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD}`,
    `Other users (elif|murat|selin|deniz @viberr.dev): ${SEED_DEFAULT_PASSWORD}`,
  ].join("\n"),
);
