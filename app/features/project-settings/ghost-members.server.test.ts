import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  deleteOrgUser,
  pruneUserFromProjects,
} from "~/server/org/org-users.server";
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
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
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

  it("pruning a user who is a member of nothing is a no-op", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pruned = await pruneUserFromProjects(
      store.db,
      store.users.deniz.id,
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(pruned).toEqual([]);
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

    await expect(
      removeMember(
        store.db,
        { projectSlug: store.slug, targetUserId: store.users.murat.id },
        { userId: store.users.selin.id, label: "selin" },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow();
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
