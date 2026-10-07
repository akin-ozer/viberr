/**
 * Seeds the PRODUCT baseline — a clean sheet, no demo/mock board data:
 * the built-in agent catalog templates (operator, developer, reviewer),
 * org resources (knowledge bases with real files, skills), and — on an EMPTY users table — the bootstrap admin from
 * VIBERR_SEED_ADMIN_EMAIL / VIBERR_SEED_ADMIN_PASSWORD (defaults
 * admin@viberr.dev / the seed default password).
 *
 *   npm run seed             — idempotent upsert/overwrite
 *   npm run seed -- --reset  — wipe projects/, agents/profiles, runtime
 *                              transcripts and all derived tables first,
 *                              then kb/, skills/ and the org KB, skill, MCP
 *                              server and domain-allowlist rows (users/auth,
 *                              GitHub connections and PATs, backend
 *                              credentials and runtime credential homes
 *                              survive; docs/development/scripts.md §3)
 *
 * Takes the data-root WRITER lock first (B-FD1) and refuses to run while
 * another Viberr process holds it. There is NO in-app equivalent of this
 * command, so the safe ordering is: seed BEFORE starting the app (as the
 * README quickstart does), or stop the app and seed. `docker compose exec app
 * npm run seed` against a RUNNING container is exactly the two-writers-on-one-
 * root shape that has already cost this project a WAL — it is now refused
 * rather than silently corrupting.
 */
import { getEnv } from "../app/server/config/env.server";
import { runWithDataRootWriterLock } from "../app/server/db/cli-lock.server";
import { getDb } from "../app/server/db/sqlite.server";
import { seedOrgResources } from "../app/server/org/org-seed.server";
import { SEED_DEFAULT_PASSWORD } from "../app/server/seed/seed-credentials";
import { runSeed } from "../app/server/seed/seed.server";

const env = getEnv();
const reset = process.argv.includes("--reset");

await runWithDataRootWriterLock(
  "`npm run seed`",
  async () => {
    // An unset VIBERR_SEED_ADMIN_EMAIL must leave `email` ABSENT, not empty:
    // runSeed falls back to the default bootstrap address on absence.
    const adminEmail = env.VIBERR_SEED_ADMIN_EMAIL;
    const adminPassword = env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD;
    const summary = await runSeed(getDb(), {
      dataRoot: env.VIBERR_DATA_ROOT,
      reset,
      admin: adminEmail
        ? { email: adminEmail, password: adminPassword }
        : { password: adminPassword },
    });

    // Org resources: KBs with real files and skills. No MCP servers, no GitHub
    // connection and no Google allowlist domain (ruling 688) are fabricated.
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
        `  gh connections ${org.connections}`,
        "",
        summary.adminCreated
          ? `Sign in: ${summary.adminEmail} / ${env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD}`
          : `Admin untouched (users already exist) — bootstrap admin only applies to an empty users table.`,
      ].join("\n"),
    );
  },
  {
    dataRoot: env.VIBERR_DATA_ROOT,
    alternative:
      "There is no in-app equivalent of the product seed: stop the app, seed, then start it (or seed a fresh data root before the first start).",
  },
);
