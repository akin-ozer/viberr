import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import {
  credentialPasswordHash,
  isBetterAuthPasswordHash,
  provisionIdentity,
  setCredentialPassword,
} from "~/server/auth/identity.server";
import { hashPassword } from "~/server/auth/password.server";
import {
  DEFAULT_SEED_ADMIN_EMAIL,
  seedInitialAdmin,
} from "~/server/auth/seed-admin.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  ensureDataRootDirs,
  projectsDir,
} from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { SEED_AGENT_PROFILES } from "./agent-catalog.server";
import { builtinAgentProfileTemplate } from "./default-assets.server";
import { SEED_DEFAULT_PASSWORD } from "./seed-credentials";

/**
 * PRODUCT seed — a clean sheet (owner ruling, 2026-07-24): no demo/mock board
 * data. What it ships:
 *
 *   - the built-in agent catalog templates (operator, developer, reviewer) as
 *     org-level profile files — the roster every project deploys;
 *   - the bootstrap ADMIN, on an EMPTY users table only, from the configured
 *     credentials (CLI: VIBERR_SEED_ADMIN_EMAIL / VIBERR_SEED_ADMIN_PASSWORD,
 *     defaults admin@viberr.dev / SEED_DEFAULT_PASSWORD) — the same
 *     `seedInitialAdmin` bootstrap boot runs;
 *   - a projection rescan over whatever REAL project files exist.
 *
 * Projects, tasks, notifications, extra users — none are seeded. The old mock
 * dataset lives on ONLY as a test fixture (test-support/demo-seed.ts). Org
 * resources (KBs with real files, skills, the domain allowlist) are seeded
 * separately by seedOrgResources (org-seed.server.ts).
 *
 * Idempotent: profile templates are overwritten, the rescan reconciles
 * projections, and an existing admin is never touched — except the P11-01
 * recovery: a stored credential in a legacy/unverifiable format (a data root
 * seeded before the better-auth migration) is re-hashed to the configured
 * password so `npm run seed` restores access instead of leaving the admin
 * locked out. `--reset` wipes projects/, agents/profiles, the per-backend
 * runtime transcript dirs and all derived tables first; users/auth and
 * runtime credential homes survive.
 */

// Re-exported so every existing importer keeps working; the constant itself
// lives in an import-free module so non-Vite consumers (playwright.config.ts)
// can read it without pulling in the `?raw` asset imports.
export { SEED_DEFAULT_PASSWORD } from "./seed-credentials";

export interface SeedOptions {
  dataRoot: string;
  reset?: boolean;
  /** Bootstrap-admin credentials; defaults admin@viberr.dev / SEED_DEFAULT_PASSWORD. */
  admin?: { email?: string; password?: string };
}

export interface SeedSummary {
  /** True when the bootstrap admin was created this run (empty users table). */
  adminCreated: boolean;
  adminEmail: string;
  agentProfiles: number;
  rescanChanged: number;
}

const DERIVED_TABLES = [
  "staged_outcomes",
  "run_log_lines",
  "agent_runs",
  "notifications",
  "provenance",
  "diagnostics",
  // Board/task-derived state. scope_violations + user_prefs were previously
  // left behind, so an open violation or a per-user pref survived a clean-sheet
  // reset and resurfaced as a phantom Settings badge when a same-slug project
  // was recreated (DM-3). A clean sheet clears the work, keeping only org config
  // (GitHub connections, MCP servers, KBs, skills) + auth/credentials.
  "scope_violations",
  "user_prefs",
  "task_events",
  "task_projections",
  "project_members",
  "projects",
];

/**
 * Wipe the store back to a clean sheet: projects/, agents/profiles, the raw
 * runtime .jsonl transcript truth, and every derived table. Scoped to the
 * per-backend RUN-LOG dirs (`runtimes/<backend>/<id>.jsonl`) and NEVER the
 * per-person runtime homes that also live under `runtimes/` — ruling 127 put
 * every vendor sign-in there (`users/<id>/codex-home/auth.json`,
 * `users/<id>/claude-home/.credentials.json`), so deleting them would sign
 * every person on the instance out of their own accounts (P11-04, when the
 * homes were still deployment-wide). Users/auth tables are preserved.
 */
export function resetStore(db: DatabaseSync, dataRoot: string): void {
  const projRoot = projectsDir(dataRoot);
  if (existsSync(projRoot)) {
    rmSync(projRoot, { recursive: true, force: true });
  }
  const profilesRoot = path.join(dataRoot, "agents", "profiles");
  if (existsSync(profilesRoot)) {
    rmSync(profilesRoot, { recursive: true, force: true });
  }
  const runtimesRoot = path.join(dataRoot, "runtimes");
  for (const backend of ["claude", "codex"] as const) {
    const transcriptDir = path.join(runtimesRoot, backend);
    if (existsSync(transcriptDir)) {
      rmSync(transcriptDir, { recursive: true, force: true });
    }
  }
  for (const table of DERIVED_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  ensureDataRootDirs(dataRoot);
  logger.info("seed reset complete", { dataRoot });
}

export async function runSeed(
  db: DatabaseSync,
  options: SeedOptions,
): Promise<SeedSummary> {
  const dataRoot = options.dataRoot;
  ensureDataRootDirs(dataRoot);

  if (options.reset) resetStore(db, dataRoot);

  // 1. Bootstrap admin — the SAME first-boot bootstrap boot runs: created only
  //    while the users table is empty; after that, admins manage users in-app.
  const adminEmail = (options.admin?.email ?? DEFAULT_SEED_ADMIN_EMAIL).toLowerCase();
  const adminPassword = options.admin?.password ?? SEED_DEFAULT_PASSWORD;
  const bootstrap = await seedInitialAdmin(db, {
    email: adminEmail,
    password: adminPassword,
  });
  if (!bootstrap.created) {
    const existing = findUserByEmail(db, adminEmail);
    if (existing) {
      // Recovery path (P11-01): a credential left in a legacy/foreign format
      // can never be verified — the account is locked out and `--reset` doesn't
      // help (auth tables are preserved). Re-hash to the configured password so
      // the seed restores access. A user with a valid better-auth hash (e.g. a
      // legitimately changed password) is left untouched.
      provisionIdentity(db, {
        id: existing.id,
        email: existing.email,
        name: existing.name,
        passwordHash: null,
      });
      if (!isBetterAuthPasswordHash(credentialPasswordHash(db, existing.id))) {
        setCredentialPassword(db, existing.id, await hashPassword(adminPassword));
        logger.warn("seed re-hashed the admin's legacy/unverifiable credential", {
          email: adminEmail,
        });
      }
    } else {
      logger.info(
        "seed admin not created — users already exist (the bootstrap only runs on an empty users table)",
        { email: adminEmail },
      );
    }
  }

  // 2. Org-level agent profile templates (the built-in catalog, layer 1).
  //    P13-AP-03: emitted through the SAME builder the boot backfill uses, so
  //    the template body is the SHIPPED PERSONA (assets/<id>.definition.md) and
  //    not the 2-sentence catalog blurb. Seed used to write the blurb, and the
  //    backfill skips files that already exist — so on the documented install
  //    order (seed → dev) every built-in agent ran on a blurb system prompt,
  //    permanently. `kbGrants: true` because `npm run seed` also seeds the
  //    backing knowledge bases (seedOrgResources); the bare boot backfill
  //    doesn't, which is the one field the two writers differ on.
  for (const profile of SEED_AGENT_PROFILES) {
    writeFileAtomic(
      agentProfileFilePath(profile.frontmatter.id, dataRoot),
      builtinAgentProfileTemplate(profile, { kbGrants: true }),
    );
  }

  // 3. Projections — reconcile whatever REAL project files exist (none on a
  //    fresh or reset store; the board starts empty by design).
  const rescan = rebuildAll(db, { dataRoot, force: true });

  recordAudit(db, {
    action: "seed.baseline",
    actor: SYSTEM_ACTOR,
    details: {
      reset: options.reset ?? false,
      adminCreated: bootstrap.created,
      agentProfiles: SEED_AGENT_PROFILES.length,
    },
  });

  const summary: SeedSummary = {
    adminCreated: bootstrap.created,
    adminEmail,
    agentProfiles: SEED_AGENT_PROFILES.length,
    rescanChanged: rescan.changed,
  };
  logger.info("seed complete", { ...summary });
  return summary;
}
