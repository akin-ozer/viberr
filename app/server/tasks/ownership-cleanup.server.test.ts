import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeMember } from "~/features/project-settings/settings-actions.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { recoverOwnershipCleanupIntents } from "./ownership-cleanup.server";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";

describe("durable ownership cleanup convergence", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        ownerUserId: store.users.selin.id,
      }),
      goal: "Recover a canonically released acceptance seat.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  });

  afterEach(() => ctx.cleanup());

  it("boot restores projection and audit once after canonical owner release", async () => {
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await expect(
      removeMember(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.selin.id,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          afterOwnershipCanonicalReleaseForTests: () => {
            throw new Error("injected post-owner-file crash");
          },
        },
      ),
    ).rejects.toThrow("injected post-owner-file crash");

    const canonical = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(canonical.frontmatter.ownerUserId).toBeNull();
    expect(
      canonical.timeline.filter((event) => event.sourceIntentId),
    ).toHaveLength(1);
    expect(
      store.db
        .prepare(
          `SELECT owner_user_id FROM task_projections
            WHERE project_slug = ? AND task_key = 'VIB-1'`,
        )
        .get(store.slug),
    ).toEqual({ owner_user_id: store.users.selin.id });
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM ownership_cleanup_intents`)
        .get(),
    ).toEqual({ n: 1 });
    expect(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM audit_events
            WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ n: 0 });
    // Access loss is the prerequisite commit: recovery is now authorized to
    // finish the exact task release even though its projection/audit lagged.
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.some(
        (member) => member.userId === store.users.selin.id,
      ),
    ).toBe(false);

    await expect(
      recoverOwnershipCleanupIntents(store.db, {
        dataRoot: store.dataRoot,
      }),
    ).resolves.toEqual({ completed: 1, cancelled: 0, errors: 0 });
    await expect(
      recoverOwnershipCleanupIntents(store.db, {
        dataRoot: store.dataRoot,
      }),
    ).resolves.toEqual({ completed: 0, cancelled: 0, errors: 0 });

    expect(
      store.db
        .prepare(
          `SELECT owner_user_id FROM task_projections
            WHERE project_slug = ? AND task_key = 'VIB-1'`,
        )
        .get(store.slug),
    ).toEqual({ owner_user_id: null });
    const audits = store.db
      .prepare(
        `SELECT actor_user_id, actor_label, details_json FROM audit_events
          WHERE action = 'task.ownership.admin_released'`,
      )
      .all() as Array<{
      actor_user_id: string;
      actor_label: string;
      details_json: string;
    }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: actor.userId,
      actor_label: actor.label,
    });
    expect(JSON.parse(audits[0]!.details_json)).toMatchObject({
      previousOwnerUserId: store.users.selin.id,
      sourceIntentId: canonical.timeline[0]!.sourceIntentId,
    });
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM ownership_cleanup_intents`)
        .get(),
    ).toEqual({ n: 0 });
  });
});
