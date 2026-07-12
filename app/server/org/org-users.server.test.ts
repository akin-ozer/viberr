import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { hashPassword } from "~/server/auth/password.server";
import { verifyPassword } from "~/server/auth/password.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  findUserByEmail,
  insertUser,
  recordUserLogin,
} from "~/server/auth/user-store.server";
import {
  addDomain,
  createLocalAccount,
  deleteOrgUser,
  findDomainAllowlistRole,
  listDomains,
  listOrgUsers,
  normalizeDomain,
  removeDomain,
  resetLocalPassword,
  setOrgUserRole,
  updateOrgUser,
  whitelistGithubUser,
  whitelistGoogleAccount,
} from "./org-users.server";

/**
 * Users & access server layer: whitelist rows via the phase-2 model,
 * status derivation, guards (self handled at route level; last-admin
 * here), domain allowlist normalization + dedupe.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_admin", label: "admin@test" };

function makeDb() {
  const db = ctx.makeDb();
  insertUser(db, {
    id: "u_admin",
    email: "admin@test.dev",
    name: "Admin Test",
    role: "admin",
    passwordHash: hashPassword("viberr-dev-2828"),
  });
  return db;
}

describe("whitelisting", () => {
  it("github handle → placeholder identity row, status whitelisted", () => {
    const db = makeDb();
    const { user, toast } = whitelistGithubUser(
      db,
      { handle: "@octocat", role: "member" },
      ACTOR,
    );
    expect(user).toMatchObject({
      name: "@octocat",
      email: "github.com/octocat",
      idp: "github",
      status: "whitelisted",
      role: "member",
      tone: "teal",
    });
    expect(toast).toBe("@octocat whitelisted — allowed at first GitHub sign-in");
    // Dedupe.
    expect(() =>
      whitelistGithubUser(db, { handle: "octocat", role: "member" }, ACTOR),
    ).toThrowError(/already whitelisted/);
  });

  it("google account → passwordless row (the row IS the whitelist)", () => {
    const db = makeDb();
    const { user } = whitelistGoogleAccount(
      db,
      { email: "Deniz@Company.dev", role: "member" },
      ACTOR,
    );
    expect(user).toMatchObject({
      name: "deniz",
      email: "deniz@company.dev",
      idp: "google",
      status: "whitelisted",
    });
    const record = findUserByEmail(db, "deniz@company.dev");
    expect(record!.passwordHash).toBeNull();
  });

  it("local account → temp password surfaced once, status invited; first login flips to active", () => {
    const db = makeDb();
    const { user, tempPassword } = createLocalAccount(
      db,
      { name: "Yeni Kişi", email: "yeni@test.dev", role: "member" },
      ACTOR,
    );
    expect(user.status).toBe("invited");
    expect(user.pwreset).toBe(false); // invited absorbs the pending flag
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);
    const record = findUserByEmail(db, "yeni@test.dev")!;
    expect(verifyPassword(tempPassword, record.passwordHash)).toBe(true);
    expect(record.pwresetRequired).toBe(true);

    recordUserLogin(db, record.id);
    const view = listOrgUsers(db).find((u) => u.id === record.id)!;
    expect(view.status).toBe("active");
  });
});

describe("edit / role / reset / remove", () => {
  it("updates a local user's name + email with dedupe", () => {
    const db = makeDb();
    const { user } = createLocalAccount(
      db,
      { name: "Yeni Kişi", email: "yeni@test.dev", role: "member" },
      ACTOR,
    );
    const updated = updateOrgUser(
      db,
      { userId: user.id, name: "Yeni İsim", email: "yepyeni@test.dev", role: "member" },
      ACTOR,
    );
    expect(updated.name).toBe("Yeni İsim");
    expect(updated.email).toBe("yepyeni@test.dev");
    expect(() =>
      updateOrgUser(
        db,
        { userId: user.id, name: "X Y", email: "admin@test.dev", role: "member" },
        ACTOR,
      ),
    ).toThrowError(/already exists/);
  });

  it("last-admin demotion is refused (phase-2 guard)", () => {
    const db = makeDb();
    expect(() =>
      setOrgUserRole(db, { userId: "u_admin", role: "member" }, ACTOR),
    ).toThrowError(/last active admin/);
  });

  it("reset is local-only, kills the flag into a pending pill", () => {
    const db = makeDb();
    const gh = whitelistGithubUser(db, { handle: "octocat", role: "member" }, ACTOR);
    expect(() => resetLocalPassword(db, gh.user.id, ACTOR)).toThrowError(
      /signs in with GitHub/,
    );

    const local = createLocalAccount(
      db,
      { name: "Selin Test", email: "selin@test.dev", role: "member" },
      ACTOR,
    );
    recordUserLogin(db, local.user.id); // now an active account
    const { user, tempPassword } = resetLocalPassword(db, local.user.id, ACTOR);
    expect(user.pwreset).toBe(true);
    expect(user.status).toBe("active");
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);
  });

  it("removes a user row but never the last active admin", async () => {
    const db = makeDb();
    const dataRoot = ctx.makeTempDir();
    const { user } = createLocalAccount(
      db,
      { name: "Gidici", email: "gidici@test.dev", role: "member" },
      ACTOR,
    );
    const removed = await deleteOrgUser(db, user.id, ACTOR, { dataRoot });
    expect(removed.toast).toBe("Gidici removed");
    expect(findUserByEmail(db, "gidici@test.dev")).toBeNull();

    await expect(
      deleteOrgUser(db, "u_admin", ACTOR, { dataRoot }),
    ).rejects.toThrowError(/last active admin/);
  });

  // WI-3: delete must remove the better-auth identity too, so re-creating the
  // same email later doesn't hit the UNIQUE constraint on "user".email.
  it("delete removes the better-auth identity so the email can be reused", async () => {
    const db = makeDb();
    const dataRoot = ctx.makeTempDir();
    const { user } = createLocalAccount(
      db,
      { name: "Reuse", email: "reuse@test.dev", role: "member" },
      ACTOR,
    );
    expect(
      db.prepare(`SELECT id FROM "user" WHERE id=?`).get(user.id),
    ).toBeTruthy();

    await deleteOrgUser(db, user.id, ACTOR, { dataRoot });
    expect(db.prepare(`SELECT id FROM "user" WHERE id=?`).get(user.id)).toBeUndefined();

    // Re-creating the same email succeeds (no orphaned identity constraint).
    const again = createLocalAccount(
      db,
      { name: "Reuse Two", email: "reuse@test.dev", role: "member" },
      ACTOR,
    );
    expect(again.user.email).toBe("reuse@test.dev");
  });

  it("removes canonical memberships and releases owned tasks before identity deletion", async () => {
    const store = setupTestStore(ctx);
    const target = store.users.selin;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-77", {
        ownerUserId: target.id,
        waiting: "human",
        recommendations: [
          {
            id: "rec-keep",
            kind: "transition",
            label: "Keep this decision",
            detail: "The pending decision survives account cleanup.",
            toStageId: "ready",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const removed = await deleteOrgUser(
      store.db,
      target.id,
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );

    expect(removed.toast).toContain("removed");
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    expect(
      project.parsed.frontmatter.members.some(
        (member) => member.userId === target.id,
      ),
    ).toBe(false);
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-77",
      dataRoot: store.dataRoot,
    })!;
    expect(task.parsed.frontmatter.ownerUserId).toBeNull();
    expect(task.parsed.frontmatter.recommendations).toHaveLength(1);
    expect(task.parsed.timeline[0]?.type).toBe("assign");
    expect(findUserByEmail(store.db, target.email)).toBeNull();
  });

  it("preflights sole project-admin membership without partially deleting the account", async () => {
    const store = setupTestStore(ctx);
    const target = store.users.arda;
    insertUser(store.db, {
      id: "u_backup_org_admin",
      email: "backup-admin@viberr.test",
      name: "Backup Org Admin",
      role: "admin",
      passwordHash: hashPassword("viberr-dev-2828"),
    });

    await expect(
      deleteOrgUser(
        store.db,
        target.id,
        { userId: store.users.murat.id, label: store.users.murat.email },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/Promote another project admin/);
    expect(findUserByEmail(store.db, target.email)).not.toBeNull();
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    expect(
      project.parsed.frontmatter.members.some(
        (member) => member.userId === target.id,
      ),
    ).toBe(true);
  });
});

describe("google domain allowlist", () => {
  it("normalizes, dedupes and removes", () => {
    const db = makeDb();
    expect(normalizeDomain("someone@Company.DEV")).toBe("@company.dev");
    expect(normalizeDomain("@company.dev")).toBe("@company.dev");
    expect(normalizeDomain("nonsense")).toBeNull();

    const added = addDomain(db, { domain: "elif@viberr.dev", role: "member" }, ACTOR);
    expect(added.status).toBe("added");
    if (added.status === "added") {
      expect(added.domain.domain).toBe("@viberr.dev");
      expect(added.toast).toBe(
        "Anyone with @viberr.dev can now sign in with Google — joins as member",
      );
    }

    const dup = addDomain(db, { domain: "@viberr.dev", role: "admin" }, ACTOR);
    expect(dup.status).toBe("duplicate");
    if (dup.status === "duplicate") {
      expect(dup.message).toBe("@viberr.dev is already whitelisted");
    }

    expect(findDomainAllowlistRole(db, "anyone@viberr.dev")).toBe("member");
    expect(findDomainAllowlistRole(db, "anyone@other.dev")).toBeNull();

    const [domain] = listDomains(db);
    const removed = removeDomain(db, domain!.id, ACTOR);
    expect(removed.toast).toBe("@viberr.dev removed from the allowlist");
    expect(listDomains(db)).toHaveLength(0);
  });
});
