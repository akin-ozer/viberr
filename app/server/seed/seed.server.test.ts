import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { runDemoSeed } from "../../../test-support/demo-seed";
import { findUserByEmail, listUsers } from "~/server/auth/user-store.server";
import {
  credentialPasswordHash,
  isBetterAuthPasswordHash,
  setCredentialPassword,
} from "~/server/auth/identity.server";
import { verifyPassword } from "~/server/auth/password.server";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import { agentProfileFilePath } from "~/server/files/file-store-root.server";
import { seedDefaultAgentAssets } from "./default-assets.server";
import { runSeed, SEED_DEFAULT_PASSWORD } from "./seed.server";

/**
 * The PRODUCT seed — a clean sheet (owner ruling 2026-07-24): built-in agent
 * catalog + bootstrap admin, and NOTHING on the board. The mock dataset moved
 * to test-support/demo-seed.ts (see demo-fixture.test.ts).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function counts(db: ReturnType<typeof ctx.makeDb>) {
  // SAFETY: every `sql` below is a `count(*) AS c` aggregate with no GROUP BY —
  // sqlite answers each with exactly one row carrying the integer column `c`.
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    users: c(`SELECT count(*) AS c FROM users`),
    projects: c(`SELECT count(*) AS c FROM projects`),
    tasks: c(`SELECT count(*) AS c FROM task_projections`),
    notifications: c(`SELECT count(*) AS c FROM notifications`),
    runs: c(`SELECT count(*) AS c FROM agent_runs`),
    scopeViolations: c(`SELECT count(*) AS c FROM scope_violations`),
    userPrefs: c(`SELECT count(*) AS c FROM user_prefs`),
  };
}

describe("runSeed (clean-sheet product seed)", () => {
  it("ships the agent catalog + admin and NO board data", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    const summary = await runSeed(db, { dataRoot });

    // Clean sheet: no projects, tasks, notifications, run history, or
    // board-derived leftovers.
    expect(counts(db)).toEqual({
      users: 1,
      projects: 0,
      tasks: 0,
      notifications: 0,
      runs: 0,
      scopeViolations: 0,
      userPrefs: 0,
    });

    // The built-in catalog templates are on disk (operator/developer/reviewer/
    // frontend-design — every profile in SEED_AGENT_PROFILES, not just the
    // base agents auto-deployed into a project's roster).
    expect(summary.agentProfiles).toBe(4);
    for (const id of ["operator", "developer", "reviewer", "frontend-design"]) {
      expect(existsSync(agentProfileFilePath(id, dataRoot)), id).toBe(true);
    }

    // The default bootstrap admin signs in with the seed default password.
    expect(summary.adminCreated).toBe(true);
    expect(summary.adminEmail).toBe("admin@viberr.dev");
    const admin = findUserByEmail(db, "admin@viberr.dev")!;
    expect(admin.role).toBe("admin");
    await expect(
      verifyPassword(SEED_DEFAULT_PASSWORD, credentialPasswordHash(db, admin.id)),
    ).resolves.toBe(true);
  });

  it("AP-03: the seeded specialist templates carry the SHIPPED persona, not the catalog blurb", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runSeed(db, { dataRoot });

    // The template BODY is the agent's system prompt (agents-query
    // `effectiveProfileView.definition` → buildSpecialistPersona). Seed used to
    // write the 2-sentence catalog blurb there, and the boot backfill only
    // writes files that are MISSING — so on the documented install order
    // (`npm run seed` then `npm run dev`) the rich personas never reached disk.
    for (const [id, opening] of [
      ["developer", "You are the Developer"],
      ["reviewer", "You are the Reviewer"],
    ] as const) {
      const { parsed } = parseAgentProfileContent(
        readFileSync(agentProfileFilePath(id, dataRoot), "utf8"),
        { fallbackId: id },
      );
      expect(parsed, id).not.toBeNull();
      expect(parsed!.description, id).toContain(opening);
      // The blurb still ships — as the short scannable `desc` the operator
      // selects on — but it is NOT the persona.
      expect(parsed!.frontmatter.desc.length, id).toBeGreaterThan(0);
      expect(parsed!.description, id).not.toBe(parsed!.frontmatter.desc);
    }
  });

  it("AP-03: the boot backfill leaves the seeded personas alone (install order seed → dev)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runSeed(db, { dataRoot });
    // Step 4 of the README: booting the app backfills default assets. It skips
    // files that exist, so the seeded bytes must ALREADY be the right ones.
    seedDefaultAgentAssets(dataRoot);

    const { parsed } = parseAgentProfileContent(
      readFileSync(agentProfileFilePath("developer", dataRoot), "utf8"),
      { fallbackId: "developer" },
    );
    expect(parsed!.description).toContain("You are the Developer");

    // Both writers agree on everything but the KB grants (`npm run seed` also
    // seeds the backing KBs via seedOrgResources; the bare backfill does not).
    const backfillOnly = ctx.makeTempDir();
    seedDefaultAgentAssets(backfillOnly);
    const fresh = parseAgentProfileContent(
      readFileSync(agentProfileFilePath("developer", backfillOnly), "utf8"),
      { fallbackId: "developer" },
    ).parsed!;
    expect(fresh.description).toBe(parsed!.description);
    expect(fresh.frontmatter.resources.kb).toEqual([]);
    expect(parsed!.frontmatter.resources.kb).toEqual([
      "architecture-notes",
      "api-contracts",
      "repo-conventions",
    ]);
  });

  it("honors env-configured admin credentials", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    const summary = await runSeed(db, {
      dataRoot,
      admin: { email: "Boss@Example.com", password: "boss-password-1" },
    });
    expect(summary.adminEmail).toBe("boss@example.com"); // lowercased
    const admin = findUserByEmail(db, "boss@example.com")!;
    expect(admin.role).toBe("admin");
    expect(admin.name).toBe("Boss"); // derived from the email local part
    await expect(
      verifyPassword("boss-password-1", credentialPasswordHash(db, admin.id)),
    ).resolves.toBe(true);
  });

  it("bootstraps only on an EMPTY users table — a re-seed adds no user", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runSeed(db, { dataRoot });
    const again = await runSeed(db, {
      dataRoot,
      admin: { email: "other@example.com", password: "other-password-1" },
    });
    expect(again.adminCreated).toBe(false);
    expect(listUsers(db)).toHaveLength(1); // still just the first admin
    expect(findUserByEmail(db, "other@example.com")).toBeNull();
  });

  it("re-hashes the admin's legacy/unverifiable credential (P11-01 recovery)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runSeed(db, { dataRoot });
    const admin = findUserByEmail(db, "admin@viberr.dev")!;
    // Simulate a data root seeded before the better-auth migration: the stored
    // credential is in the legacy `scrypt$...` format the verifier throws on.
    setCredentialPassword(
      db,
      admin.id,
      "scrypt$16384$8$1$firuPx6uzlhAacmTd73at1OAoHciD9IbvW83I1VQvO0=$pX5ob5jrx1kC1KRCGKpsYCtiHZNXCQPO9zbo8RsKN9aRNG7aA3uG0plZc9JfpeL/DQk8A+iAx+cvrJmgwaRfdg==",
    );
    expect(isBetterAuthPasswordHash(credentialPasswordHash(db, admin.id))).toBe(false);
    // Re-running the seed restores a working credential.
    await runSeed(db, { dataRoot });
    const repaired = credentialPasswordHash(db, admin.id);
    expect(isBetterAuthPasswordHash(repaired)).toBe(true);
    await expect(verifyPassword(SEED_DEFAULT_PASSWORD, repaired)).resolves.toBe(true);
  });

  it("--reset wipes demo/board leftovers into a clean sheet", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    // A store carrying the old demo dataset (the test fixture writes exactly
    // what the old production seed wrote).
    await runDemoSeed(db, { dataRoot });
    const before = counts(db);
    expect(before.projects).toBeGreaterThan(0);
    // Board-derived leftovers that used to survive a reset (DM-3). The demo
    // fixture already carries an open scope violation; add a per-user pref too.
    // SAFETY: the SELECT list is the single `users.id` column, and the demo seed
    // above inserted its people — `before.projects > 0` already proved it ran.
    const anyUser = (db.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
    db.prepare(
      `INSERT OR REPLACE INTO user_prefs (user_id, key, value_json, updated_at)
       VALUES (?, 'theme', '"dark"', '2026-07-24T00:00:00Z')`,
    ).run(anyUser);
    expect(before.scopeViolations).toBeGreaterThan(0);
    expect(counts(db).userPrefs).toBeGreaterThan(0);

    await runSeed(db, { dataRoot, reset: true });

    const after = counts(db);
    expect(after.projects).toBe(0);
    expect(after.tasks).toBe(0);
    expect(after.notifications).toBe(0);
    // The board-derived leftovers are gone — no phantom badges on re-create.
    expect(after.scopeViolations).toBe(0);
    expect(after.userPrefs).toBe(0);
    // Users/auth survive a reset (the demo people remain until a DB wipe).
    expect(after.users).toBeGreaterThan(0);
  });

  it("--reset preserves runtime credential homes, wipes only transcript dirs (P11-04)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runSeed(db, { dataRoot });
    // A configured Codex credential home + a run transcript dir under runtimes/.
    const codexAuth = join(dataRoot, "runtimes", "codex-home", "auth.json");
    const claudeHome = join(dataRoot, "runtimes", "claude-home", "config.json");
    const transcript = join(dataRoot, "runtimes", "codex", "run_abc.jsonl");
    mkdirSync(dirname(codexAuth), { recursive: true });
    mkdirSync(dirname(claudeHome), { recursive: true });
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(codexAuth, '{"token":"secret"}');
    writeFileSync(claudeHome, "{}");
    writeFileSync(transcript, "{}\n");

    await runSeed(db, { dataRoot, reset: true });

    expect(existsSync(codexAuth)).toBe(true); // credential home preserved
    expect(existsSync(claudeHome)).toBe(true);
    expect(existsSync(transcript)).toBe(false); // transcript wiped
  });
});
