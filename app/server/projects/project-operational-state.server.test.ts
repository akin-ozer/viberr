import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteProject } from "~/features/project-settings/settings-actions.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
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

  afterEach(() => ctx.cleanup());

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

    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: "Viberr Core" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );

    for (const table of [
      "agent_runs",
      "project_github_credentials",
      "scope_violations",
      "notifications",
      "task_projections",
      "task_events",
    ]) {
      const row = store.db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE project_slug = ?`)
        .get(store.slug) as { n: number };
      expect(row.n, table).toBe(0);
    }
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM run_log_lines WHERE run_id = ?`)
          .get(runId) as { n: number }
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
          .prepare(`SELECT count(*) AS n FROM audit_events WHERE project_slug = ?`)
          .get(store.slug) as { n: number }
      ).n,
    ).toBe(0);

    writeProject(
      store.dataRoot,
      original.frontmatter,
      original.description,
    );
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
  });
});
