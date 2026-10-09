import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listRecentAuditEvents } from "./audit-browse.server";

/**
 * PG26-A: the in-app audit browse query. Recent events newest-first, with the
 * org/instance-scoped rows (`project_slug` NULL) — the class that had no in-app
 * view — carried through as `projectSlug: null`.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function insert(
  db: DatabaseSync,
  row: {
    id: string;
    occurredAt: string;
    actorLabel: string;
    action: string;
    subjectId: string | null;
    projectSlug: string | null;
  },
) {
  db.prepare(
    `INSERT INTO audit_events
       (id, occurred_at, actor_user_id, actor_label, action,
        subject_kind, subject_id, project_slug, task_key, details_json)
     VALUES (?, ?, ?, ?, ?, 'task', ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.occurredAt,
    null,
    row.actorLabel,
    row.action,
    row.subjectId,
    row.projectSlug,
    null,
    null,
  );
}

describe("listRecentAuditEvents", () => {
  /**
   * Ruling 33 (F37-52) — the reconcile heartbeat is not a browse row.
   *
   * `github.reconcile.task` is written on every completed poller pass per
   * delivered task, changed or not (F19-22, deliberately). On pass 37's live
   * instance that was 91 of the panel's 150 rows, with the window spanning 53
   * minutes. It is excluded HERE and nowhere else: the table, the retention
   * sweep, the export and `latestTaskReconcileCheckAt` all still see it.
   */
  it("excludes the per-tick reconcile heartbeat from the browse", () => {
    const db = ctx.makeDb();
    for (let i = 0; i < 5; i++) {
      insert(db, {
        id: `h${i}`,
        occurredAt: `2026-08-22T10:0${i}:00.000Z`,
        actorLabel: "system",
        action: "github.reconcile.task",
        subjectId: "VIB-1",
        projectSlug: "viberr-core",
      });
    }
    insert(db, {
      id: "real",
      occurredAt: "2026-08-22T09:00:00.000Z",
      actorLabel: "arda@viberr.dev",
      action: "github.pat.created",
      subjectId: "pat_1",
      projectSlug: null,
    });
    // The heartbeats are newer, so a plain newest-first window would be all
    // heartbeat and the PAT change would be the row pushed out.
    expect(listRecentAuditEvents(db).map((r) => r.action)).toEqual([
      "github.pat.created",
    ]);
  });

  /**
   * Ruling 33, second half — "Org-scoped" is a QUERY, not a filter over
   * whatever the unscoped window happened to return. Live, the toggle showed 2
   * rows against 96 org-scoped events on file, because a busy project filled
   * the window it was narrowing.
   */
  it("orgOnly gets its own window, reaching rows the unscoped one cannot", () => {
    const db = ctx.makeDb();
    for (let i = 0; i < 30; i++) {
      insert(db, {
        id: `t${i}`,
        occurredAt: `2026-08-22T11:${String(i).padStart(2, "0")}:00.000Z`,
        actorLabel: "arda@viberr.dev",
        action: "task.metadata.updated",
        subjectId: "VIB-1",
        projectSlug: "viberr-core",
      });
    }
    insert(db, {
      id: "signin",
      occurredAt: "2026-08-21T08:00:00.000Z",
      actorLabel: "arda@viberr.dev",
      action: "auth.sign_in",
      subjectId: "u1",
      projectSlug: null,
    });
    // A window small enough that the sign-in is nowhere near it.
    const unscoped = listRecentAuditEvents(db, { limit: 5 });
    expect(unscoped).toHaveLength(5);
    expect(unscoped.map((r) => r.action)).not.toContain("auth.sign_in");
    // The scoped query reaches it regardless of how busy the project is.
    expect(listRecentAuditEvents(db, { limit: 5, orgOnly: true }).map((r) => r.action)).toEqual([
      "auth.sign_in",
    ]);
  });

  it("returns events newest-first with org-scoped rows carried through", () => {
    const db = ctx.makeDb();
    insert(db, {
      id: "a1",
      occurredAt: "2026-08-20T10:00:00.000Z",
      actorLabel: "arda@viberr.dev",
      action: "auth.login.success",
      subjectId: "u_1",
      projectSlug: null, // org-scoped: a sign-in
    });
    insert(db, {
      id: "a2",
      occurredAt: "2026-08-22T10:00:00.000Z",
      actorLabel: "arda@viberr.dev",
      action: "github.pat.created",
      subjectId: "pat_1",
      projectSlug: null, // org-scoped: a PAT change
    });
    insert(db, {
      id: "a3",
      occurredAt: "2026-08-21T10:00:00.000Z",
      actorLabel: "arda@viberr.dev",
      action: "task.metadata.updated",
      subjectId: "VIB-1",
      projectSlug: "viberr-core", // project-scoped
    });

    const rows = listRecentAuditEvents(db);
    // Newest first: a2 (Aug 22), a3 (Aug 21), a1 (Aug 20).
    expect(rows.map((r) => r.id)).toEqual(["a2", "a3", "a1"]);
    // The org-scoped events have a null projectSlug (the browse toggles on this).
    expect(rows.find((r) => r.id === "a2")?.projectSlug).toBeNull();
    expect(rows.find((r) => r.id === "a1")?.projectSlug).toBeNull();
    expect(rows.find((r) => r.id === "a3")?.projectSlug).toBe("viberr-core");
    expect(rows.find((r) => r.id === "a2")?.action).toBe("github.pat.created");
  });

  it("honours a limit and clamps a zero one up to one row", () => {
    const db = ctx.makeDb();
    for (let i = 0; i < 5; i++) {
      insert(db, {
        id: `e${i}`,
        occurredAt: `2026-08-2${i}T10:00:00.000Z`,
        actorLabel: "system",
        action: "projection.rescan",
        subjectId: null,
        projectSlug: null,
      });
    }
    expect(listRecentAuditEvents(db, { limit: 2 })).toHaveLength(2);
    // Zero / negative is clamped up to 1, not "no rows".
    expect(listRecentAuditEvents(db, { limit: 0 })).toHaveLength(1);
  });

  it("returns an empty array when nothing is recorded", () => {
    expect(listRecentAuditEvents(ctx.makeDb())).toEqual([]);
  });
});
