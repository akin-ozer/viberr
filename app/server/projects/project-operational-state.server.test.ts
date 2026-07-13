import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteProject } from "~/features/project-settings/settings-actions.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  projectDir,
  storeRelativePath,
} from "~/server/files/file-store-root.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  appendRawLine,
  insertRunLine,
  rawLogPath,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  enqueueAutoOperator,
  resetOperatorDispatchForTests,
} from "~/server/runtimes/operator-dispatch.server";
import { resetOperatorLeasesForTests } from "~/server/runtimes/operator-run.server";
import {
  recoverProjectDeletions,
  stageProjectDeletion,
} from "~/server/projects/project-operational-state.server";

describe("project deletion operational purge", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  });

  afterEach(() => {
    resetOperatorDispatchForTests();
    resetOperatorLeasesForTests();
    delete process.env.VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD;
    ctx.cleanup();
  });

  it("a recreated slug inherits no runs, credentials, violations, notifications, provenance, or old audit", async () => {
    const original = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed;
    const runId = "run_project_delete";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: "claude-test",
      sdk: "test",
      state: "finished",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-07-13T00:00:00.000Z",
      raw: "{}",
      display: { t: "00:00:00", ev: "text", tag: "assistant", text: "old" },
    });
    appendRawLine("claude", runId, "{}", store.dataRoot);

    store.db
      .prepare(
        `INSERT INTO github_pats
          (id, user_id, label, encrypted_token, token_suffix, created_at)
         VALUES ('pat_delete', ?, 'old', 'ciphertext', 'last', ?)`,
      )
      .run(store.users.arda.id, new Date().toISOString());
    store.db
      .prepare(
        `INSERT INTO project_github_credentials
          (project_slug, pat_id, created_at, updated_at)
         VALUES (?, 'pat_delete', ?, ?)`,
      )
      .run(store.slug, new Date().toISOString(), new Date().toISOString());
    store.db
      .prepare(
        `INSERT INTO scope_violations
          (id, project_slug, task_key, scope, detail, status, created_at)
         VALUES ('sv_delete', ?, 'VIB-1', 'contents:write', 'old', 'open', ?)`,
      )
      .run(store.slug, new Date().toISOString());
    store.db
      .prepare(
        `INSERT INTO notifications
          (id, user_id, kind, text, project_slug, task_key, occurred_at, created_at)
         VALUES ('n_delete', ?, 'approval', 'old', ?, 'VIB-1', ?, ?)`,
      )
      .run(
        store.users.arda.id,
        store.slug,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    recordAudit(store.db, {
      action: "task.comment",
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
      subjectKind: "task",
      subjectId: "VIB-1",
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
    const projectSourceRoot = storeRelativePath(
      projectDir(store.slug, store.dataRoot),
      store.dataRoot,
    );
    store.db
      .prepare(
        `INSERT INTO provenance
          (source_path, content_hash, observed_at, action, details_json)
         VALUES (?, NULL, ?, 'github.reconcile', NULL)`,
      )
      .run(
        `${projectSourceRoot}/tasks/VIB-1/task.md`,
        new Date().toISOString(),
      );
    store.db
      .prepare(
        `INSERT INTO operator_dispatches
          (id, project_slug, task_key, task_incarnation, trigger, state, run_id,
           estimated_cost_usd, created_at, started_at, finished_at,
           next_attempt_at)
         VALUES ('opd_delete', ?, 'VIB-1', '2026-07-01T09:00:00.000Z', 'create', 'queued', NULL,
                 0.05, ?, NULL, NULL, NULL)`,
      )
      .run(store.slug, new Date().toISOString());

    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: "Viberr Core" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );

    for (const table of [
      "agent_runs",
      "operator_dispatches",
      "project_github_credentials",
      "scope_violations",
      "notifications",
      "task_projections",
      "task_events",
    ]) {
      const row = store.db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE project_slug = ?`)
        .get(store.slug) as {
        n: number;
      };
      expect(row.n, table).toBe(0);
    }
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM run_log_lines WHERE run_id = ?`)
          .get(runId) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM provenance
              WHERE source_path = ? OR source_path LIKE ?`,
          )
          .get(projectSourceRoot, `${projectSourceRoot}/%`) as { n: number }
      ).n,
    ).toBe(0);
    expect(existsSync(rawLogPath("claude", runId, store.dataRoot))).toBe(false);
    const deletion = store.db
      .prepare(
        `SELECT project_slug, details_json FROM audit_events
         WHERE action = 'project.deleted' ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get() as { project_slug: string | null; details_json: string };
    expect(deletion.project_slug).toBeNull();
    expect(JSON.parse(deletion.details_json)).toMatchObject({
      formerProjectSlug: store.slug,
    });
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM audit_events WHERE project_slug = ?`,
          )
          .get(store.slug) as {
          n: number;
        }
      ).n,
    ).toBe(0);

    writeProject(store.dataRoot, original.frontmatter, original.description);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      goal: "Prove a recreated project receives fresh automatic triage.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM agent_runs WHERE project_slug = ?`,
          )
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM project_github_credentials WHERE project_slug = ?`,
          )
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(0);
    process.env.VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD = "0.001";
    const fresh = enqueueAutoOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "create",
      dataRoot: store.dataRoot,
    });
    expect(fresh.queued).toBe(true);
    expect(fresh.dispatchId).not.toBe("opd_delete");
  });

  it("boot recovery finishes a deletion that crashed after canonical removal exactly once", async () => {
    await expect(
      deleteProject(
        store.db,
        { projectSlug: store.slug, confirmName: "Viberr Core" },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          afterProjectRemovalHookForTests: () => {
            throw new Error("injected post-removal crash");
          },
        },
      ),
    ).rejects.toThrow("injected post-removal crash");

    expect(existsSync(projectDir(store.slug, store.dataRoot))).toBe(false);
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM project_deletion_tombstones
              WHERE project_slug = ?`,
          )
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(1);
    // The process died before convergent cleanup, so the old projection is
    // deliberately still present until boot recovery owns it.
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM projects WHERE slug = ?`)
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(1);

    expect(recoverProjectDeletions(store.db, store.dataRoot)).toEqual({
      completed: 1,
      cancelled: 0,
      errors: 0,
    });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM projects WHERE slug = ?`)
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM task_projections WHERE project_slug = ?`,
          )
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM project_deletion_tombstones`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
    const audits = store.db
      .prepare(
        `SELECT actor_user_id, actor_label, project_slug, details_json
           FROM audit_events
          WHERE action = 'project.deleted'`,
      )
      .all() as Array<{
      actor_user_id: string | null;
      actor_label: string;
      project_slug: string | null;
      details_json: string;
    }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: store.users.arda.id,
      actor_label: store.users.arda.email,
      project_slug: null,
    });
    expect(JSON.parse(audits[0]!.details_json)).toMatchObject({
      formerProjectSlug: store.slug,
      name: "Viberr Core",
    });

    expect(recoverProjectDeletions(store.db, store.dataRoot)).toEqual({
      completed: 0,
      cancelled: 0,
      errors: 0,
    });
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM audit_events WHERE action = 'project.deleted'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("boot recovery cancels a staged deletion that never crossed the directory commit", () => {
    stageProjectDeletion(store.db, {
      projectSlug: store.slug,
      projectName: "Viberr Core",
      actorUserId: store.users.arda.id,
      actorLabel: store.users.arda.email,
    });

    expect(recoverProjectDeletions(store.db, store.dataRoot)).toEqual({
      completed: 0,
      cancelled: 1,
      errors: 0,
    });
    expect(existsSync(projectDir(store.slug, store.dataRoot))).toBe(true);
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM project_deletion_tombstones`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("project deletion purges lifecycle and ownership recovery intents", async () => {
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO project_lifecycle_intents
           (id, project_slug, operation, expected_archived, target_archived,
            project_name, actor_user_id, actor_label, authority_source,
            stopped_runs, cancelled_dispatches, cancelled_pending_triggers,
            created_at)
         VALUES ('life_delete', ?, 'archive', 0, 1, 'Viberr Core', ?, ?,
                 'project_role', 0, 0, 0, ?)`,
      )
      .run(store.slug, store.users.arda.id, store.users.arda.email, now);
    store.db
      .prepare(
        `INSERT INTO ownership_cleanup_intents
           (id, batch_id, project_slug, task_key, task_incarnation, target_user_id,
            target_name, reason, actor_user_id, actor_label, actor_name_hint,
            authority_source, created_at)
         VALUES ('owner_delete', 'owner_batch_delete', ?, 'VIB-1', '2026-07-01T09:00:00.000Z', ?,
                 'Selin Kaya', 'member_removed', ?, ?, 'Arda', NULL, ?)`,
      )
      .run(
        store.slug,
        store.users.selin.id,
        store.users.arda.id,
        store.users.arda.email,
        now,
      );

    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: "Viberr Core" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );

    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM project_lifecycle_intents`)
        .get(),
    ).toEqual({ n: 0 });
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM ownership_cleanup_intents`)
        .get(),
    ).toEqual({ n: 0 });
  });
});
