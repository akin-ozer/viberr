/**
 * Seeds the full demo dataset (mock parity): users, agent profile
 * templates, project + task files under ${VIBERR_DATA_ROOT}/projects,
 * projections, and Arda's notification inbox.
 *
 *   npm run seed             — idempotent upsert/overwrite
 *   npm run seed -- --reset  — wipe projects/, agents/profiles and all
 *                              derived tables first, then seed fresh
 */
import { getEnv } from "../app/server/config/env.server";
import { getDb } from "../app/server/db/sqlite.server";
import { seedOrgResources } from "../app/server/org/org-seed.server";
import { runDemoSeed, SEED_DEFAULT_PASSWORD } from "../app/server/seed/demo-seed.server";

const env = getEnv();
const reset = process.argv.includes("--reset");

const summary = await runDemoSeed(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  reset,
  adminPassword: env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD,
});

// Phase 9B: org resources (KBs with real files, skills, MCP servers,
// domain allowlist, placeholder GitHub connection). Additive — the demo
// seed above is untouched.
const org = seedOrgResources(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  reset,
});

console.log(
  [
    "viberr seed complete:",
    `  users          ${summary.users}`,
    `  projects       ${summary.projects}`,
    `  tasks          ${summary.tasks}`,
    `  timeline events ${summary.events}`,
    `  notifications  ${summary.notifications}`,
    `  agent profiles ${summary.agentProfiles}`,
    `  projections changed ${summary.rescanChanged}`,
    `  org kbs        ${org.kbs} (${org.kbFiles} files)`,
    `  org skills     ${org.skills}`,
    `  org mcps       ${org.mcps}`,
    `  org domains    ${org.domains}`,
    `  gh connections ${org.connections}`,
    "",
    `Sign in: arda@viberr.dev / ${env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD}`,
    `Other users (elif|murat|selin|deniz @viberr.dev): ${SEED_DEFAULT_PASSWORD}`,
  ].join("\n"),
);
