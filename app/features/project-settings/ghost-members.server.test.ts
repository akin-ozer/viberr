import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeProject } from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { insertUser } from "~/server/auth/user-store.server";
import { deleteOrgUser } from "~/server/org/org-users.server";
import { setMemberRole } from "~/features/policy/policy-actions.server";
import { removeMember } from "./settings-actions.server";
import { countLiveAdmins, listMembershipViews } from "./membership.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_sys", label: "system" };

/**
 * UI-29 / LV-04 — org-deleted users used to survive as project members.
 *
 * `deleteOrgUser` removed the identity and the `users` row but never touched
 * project.md, so:
 *   - the Policy / Settings panels rendered `usr_9f3a…` with a LIVE role
 *     radiogroup and counted it in "N members" and every role header, and
 *   - `setMemberRole`/`removeMember`'s last-admin guard counted the ghost, so
 *     the only REAL admin could demote or remove themselves and leave a project
 *     nobody could govern.
 */
describe("UI-29: deleting an org user prunes their project memberships", () => {
  it("removes the membership from project.md and re-projects", async () => {
    const store = setupProjectedStore(ctx);
    const target = store.users.selin;

    const before = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    expect(
      before.parsed.frontmatter.members.some((m) => m.userId === target.id),
    ).toBe(true);

    const result = await deleteOrgUser(store.db, target.id, ACTOR, {
      dataRoot: store.dataRoot,
    });
    expect(result.projectsPruned).toEqual([store.slug]);
    expect(result.toast).toContain("1 project");

    const after = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    expect(
      after.parsed.frontmatter.members.some((m) => m.userId === target.id),
    ).toBe(false);
    // The projection follows the file.
    expect(
      store.db
        .prepare(
          `SELECT user_id FROM project_members WHERE project_slug = ? AND user_id = ?`,
        )
        .get(store.slug, target.id),
    ).toBeUndefined();
  });

  it("deleting a user who is a member of nothing prunes nothing", async () => {
    const store = setupProjectedStore(ctx);
    const result = await deleteOrgUser(store.db, store.users.deniz.id, ACTOR, {
      dataRoot: store.dataRoot,
    });
    expect(result.projectsPruned).toEqual([]);
    expect(result.toast).not.toContain("dropped from");
  });
});

describe("UI-29: the last-admin guard counts LIVE accounts only", () => {
  /** Leave a ghost admin behind by deleting the users row directly (the exact
   *  state the store is in today, before the prune above existed). */
  function ghostAdmin(store: ReturnType<typeof setupTestStore>): void {
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(store.users.arda.id);
  }

  it("countLiveAdmins ignores a membership with no users row", () => {
    const store = setupTestStore(ctx);
    const members = [
      { userId: store.users.arda.id, role: "admin" as const },
      { userId: "u_RT7-QeTWOwP4", role: "admin" as const },
    ];
    expect(countLiveAdmins(store.db, members)).toBe(1);
  });

  it("countLiveAdmins ignores a DISABLED admin", () => {
    const store = setupTestStore(ctx);
    store.db
      .prepare(`UPDATE users SET disabled = 1 WHERE id = ?`)
      .run(store.users.arda.id);
    expect(
      countLiveAdmins(store.db, [
        { userId: store.users.arda.id, role: "admin" },
      ]),
    ).toBe(0);
  });

  it("a ghost admin can no longer satisfy the demotion guard", async () => {
    const store = setupTestStore(ctx);
    // murat is promoted to admin so there are two admins on paper…
    await setMemberRole(
      store.db,
      {
        projectSlug: store.slug,
        targetUserId: store.users.murat.id,
        role: "admin",
      },
      { userId: store.users.arda.id, label: "arda" },
      { dataRoot: store.dataRoot },
    );
    // …then arda's account is deleted, leaving a ghost admin in project.md.
    ghostAdmin(store);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Before the fix this SUCCEEDED (two file admins), leaving a project whose
    // only "admin" was a deleted account.
    await expect(
      setMemberRole(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.murat.id,
          role: "maintainer",
        },
        { userId: store.users.murat.id, label: "murat" },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/needs at least one admin/);
  });

  it("removeMember's guard counts live admins too", async () => {
    const store = setupTestStore(ctx);
    await setMemberRole(
      store.db,
      {
        projectSlug: store.slug,
        targetUserId: store.users.murat.id,
        role: "admin",
      },
      { userId: store.users.arda.id, label: "arda" },
      { dataRoot: store.dataRoot },
    );
    ghostAdmin(store);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // An org admin who is not a member passes `manage-members` through the D2
    // override, so the only thing left to refuse the removal is the guard
    // itself (a project member below admin would be refused by RBAC first).
    const orgAdmin = insertUser(store.db, {
      id: "u_orgadmin",
      email: "orgadmin@viberr.test",
      name: "Org Admin",
      role: "admin",
    });

    // Were the ghost counted, murat would be one of two admins and the removal
    // would land.
    await expect(
      removeMember(
        store.db,
        { projectSlug: store.slug, targetUserId: store.users.murat.id },
        { userId: orgAdmin.id, label: orgAdmin.email },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/is the only admin/);
  });

  it("F18-6: a GHOST admin that is the project's ONLY admin IS removable by a live org admin (no deadlock)", async () => {
    const store = setupTestStore(ctx);
    // The exact F18-6 shape: the project's sole admin is a DELETED org account
    // (a ghost id with no users row); the live org admin (arda) is only a viewer
    // member. Before the fix, Settings→Members 409'd ("only admin — assign
    // another in Policy first") while Policy pointed back to Members — a loop
    // with no exit but hand-editing project.md.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      members: [
        { userId: "u_ghost_admin", role: "admin" }, // no users row → ghost
        { userId: store.users.arda.id, role: "viewer" }, // live org admin, viewer here
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // countLiveAdmins sees ZERO live admins (the only admin is a ghost).
    expect(
      countLiveAdmins(store.db, [{ userId: "u_ghost_admin", role: "admin" }]),
    ).toBe(0);

    // arda (org admin → D2 override) removes the ghost — this must SUCCEED.
    await removeMember(
      store.db,
      { projectSlug: store.slug, targetUserId: "u_ghost_admin" },
      { userId: store.users.arda.id, label: "arda@viberr.dev" },
      { dataRoot: store.dataRoot },
    );
    const after = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    expect(after.parsed.frontmatter.members.some((m) => m.userId === "u_ghost_admin")).toBe(false);
  });
});

describe("LV-04: a stale membership renders as a removed account", () => {
  it("marks it `missing` and never echoes the raw user id as a name", () => {
    const store = setupTestStore(ctx);
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(store.users.elif.id);

    const views = listMembershipViews(store.db, store.slug, {
      dataRoot: store.dataRoot,
    });
    const ghost = views.find((m) => m.userId === store.users.elif.id)!;
    expect(ghost.missing).toBe(true);
    expect(ghost.name).not.toBe(store.users.elif.id);
    expect(ghost.name).toContain("Removed account");
    expect(ghost.initials).toBe("?");

    // Live members are unaffected.
    const live = views.find((m) => m.userId === store.users.arda.id)!;
    expect(live.missing).toBe(false);
    expect(live.name).toBe(store.users.arda.name);
  });

  it("flags a disabled (but existing) account separately", () => {
    const store = setupTestStore(ctx);
    store.db
      .prepare(`UPDATE users SET disabled = 1 WHERE id = ?`)
      .run(store.users.elif.id);
    const views = listMembershipViews(store.db, store.slug, {
      dataRoot: store.dataRoot,
    });
    const row = views.find((m) => m.userId === store.users.elif.id)!;
    expect(row.missing).toBe(false);
    expect(row.disabled).toBe(true);
  });
});
