/**
 * Seeds the PRODUCT baseline — a clean sheet, no demo/mock board data:
 * the built-in agent catalog templates (operator, developer, reviewer),
 * org resources (knowledge bases with real files, skills, the domain
 * allowlist), and — on an EMPTY users table — the bootstrap admin from
 * VIBERR_SEED_ADMIN_EMAIL / VIBERR_SEED_ADMIN_PASSWORD (defaults
 * admin@viberr.dev / the seed default password).
 *
 *   npm run seed             — idempotent upsert/overwrite
 *   npm run seed -- --reset  — wipe projects/, agents/profiles, runtime
 *                              transcripts and all derived tables first
 *                              (users/auth + runtime credential homes survive)
 */
import { getEnv } from "../app/server/config/env.server";
import { getDb } from "../app/server/db/sqlite.server";
import { seedOrgResources } from "../app/server/org/org-seed.server";
import { runSeed, SEED_DEFAULT_PASSWORD } from "../app/server/seed/seed.server";

const env = getEnv();
const reset = process.argv.includes("--reset");

const summary = await runSeed(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  reset,
  admin: {
    ...(env.VIBERR_SEED_ADMIN_EMAIL ? { email: env.VIBERR_SEED_ADMIN_EMAIL } : {}),
    password: env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD,
  },
});

// Org resources: KBs with real files, skills, domain allowlist. No MCP
// servers and no GitHub connection are fabricated (honest empty slate).
const org = seedOrgResources(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  reset,
});

console.log(
  [
    "viberr seed complete (clean sheet — no demo board data):",
    `  agent profiles ${summary.agentProfiles}`,
    `  projections changed ${summary.rescanChanged}`,
    `  org kbs        ${org.kbs} (${org.kbFiles} files)`,
    `  org skills     ${org.skills}`,
    `  org mcps       ${org.mcps}`,
    `  org domains    ${org.domains}`,
    `  gh connections ${org.connections}`,
    "",
    summary.adminCreated
      ? `Sign in: ${summary.adminEmail} / ${env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD}`
      : `Admin untouched (users already exist) — bootstrap admin only applies to an empty users table.`,
  ].join("\n"),
);
