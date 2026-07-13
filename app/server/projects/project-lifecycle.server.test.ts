import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProjectArchived } from "~/features/project-settings/settings-actions.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  allowProjectCompletionEffects,
  projectCompletionAdmissionOpen,
} from "~/server/runtimes/run-completion-state.server";
import { recoverProjectLifecycleIntents } from "~/server/projects/project-lifecycle.server";
import { revokeCanonicalArchivedProjects } from "~/server/boot.server";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  setupTestStore,
  type TestStore,
} from "../../../test-support/test-store";

describe("durable project archive/restore convergence", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  });

  afterEach(() => ctx.cleanup());

  it("same-state archive retry restores projection and the original audit exactly once", async () => {
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          reprojectHookForTests: () => {
            throw new Error("injected post-file archive crash");
          },
        },
      ),
    ).rejects.toThrow("injected post-file archive crash");

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(true);
    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 0 });
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM project_lifecycle_intents`)
        .get(),
    ).toEqual({ n: 1 });
    expect(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'project.archived'`,
        )
        .get(),
    ).toEqual({ n: 0 });

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        { dataRoot: store.dataRoot },
      ),
    ).resolves.toMatchObject({ archived: true });
    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      { dataRoot: store.dataRoot },
    );

    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 1 });
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM project_lifecycle_intents`)
        .get(),
    ).toEqual({ n: 0 });
    const audits = store.db
      .prepare(
        `SELECT actor_user_id, actor_label, details_json
           FROM audit_events WHERE action = 'project.archived'`,
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
      authoritySource: "project_role",
      lifecycleIntentId: expect.any(String),
    });
  });

  it("boot recovers a committed restore and repeated recovery stays idempotent", async () => {
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      { dataRoot: store.dataRoot },
    );
    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: false },
        actor,
        {
          dataRoot: store.dataRoot,
          reprojectHookForTests: () => {
            throw new Error("injected post-file restore crash");
          },
        },
      ),
    ).rejects.toThrow("injected post-file restore crash");

    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 1 });
    expect(recoverProjectLifecycleIntents(store.db, store.dataRoot)).toEqual({
      completed: 1,
      cancelled: 0,
      errors: 0,
    });
    expect(recoverProjectLifecycleIntents(store.db, store.dataRoot)).toEqual({
      completed: 0,
      cancelled: 0,
      errors: 0,
    });
    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 0 });
    expect(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'project.unarchived'`,
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("boot cancels a pre-file lifecycle orphan without archiving the project", async () => {
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          afterProjectLifecycleIntentStagedForTests: () => {
            throw new Error("injected pre-file crash");
          },
        },
      ),
    ).rejects.toThrow("injected pre-file crash");
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(false);
    expect(recoverProjectLifecycleIntents(store.db, store.dataRoot)).toEqual({
      completed: 0,
      cancelled: 1,
      errors: 0,
    });
    expect(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'project.archived'`,
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 0 });
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("boot recreates the in-memory revocation fence for canonical archives", async () => {
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      { dataRoot: store.dataRoot },
    );

    // Simulate a fresh process whose in-memory admission map starts open.
    allowProjectCompletionEffects(store.db, store.slug);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
    expect(revokeCanonicalArchivedProjects(store.db, store.dataRoot)).toEqual([
      store.slug,
    ]);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);
  });
});
