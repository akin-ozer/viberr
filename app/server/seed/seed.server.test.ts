import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { agentProfileFilePath } from "~/server/files/file-store-root.server";
import { runSeed, SEED_DEFAULT_PASSWORD } from "./seed.server";

/**
 * The PRODUCT seed — a clean sheet (owner ruling 2026-07-24): built-in agent
 * catalog + bootstrap admin, and NOTHING on the board. The mock dataset moved
 * to test-support/demo-seed.ts (see demo-fixture.test.ts).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function counts(db: ReturnType<typeof ctx.makeDb>) {
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    users: c(`SELECT count(*) AS c FROM users`),
    projects: c(`SELECT count(*) AS c FROM projects`),
    tasks: c(`SELECT count(*) AS c FROM task_projections`),
    notifications: c(`SELECT count(*) AS c FROM notifications`),
    runs: c(`SELECT count(*) AS c FROM agent_runs`),
  };
}

describe("runSeed (clean-sheet product seed)", () => {
  it("ships the agent catalog + admin and NO board data", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    const summary = await runSeed(db, { dataRoot });

    // Clean sheet: no projects, tasks, notifications, or run history.
    expect(counts(db)).toEqual({
      users: 1,
      projects: 0,
      tasks: 0,
      notifications: 0,
      runs: 0,
    });

    // The built-in catalog templates are on disk (operator/developer/reviewer).
    expect(summary.agentProfiles).toBe(3);
    for (const id of ["operator", "developer", "reviewer"]) {
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
    expect(counts(db).projects).toBeGreaterThan(0);

    await runSeed(db, { dataRoot, reset: true });

    const after = counts(db);
    expect(after.projects).toBe(0);
    expect(after.tasks).toBe(0);
    expect(after.notifications).toBe(0);
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
