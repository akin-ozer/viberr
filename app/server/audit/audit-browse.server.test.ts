import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  AUDIT_BROWSE_DEFAULT_LIMIT,
  listRecentAuditEvents,
} from "./audit-browse.server";

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

  it("clamps the limit and never pages the whole table", () => {
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
    expect(listRecentAuditEvents(db, { limit: 0 }).length).toBeGreaterThanOrEqual(1);
    expect(AUDIT_BROWSE_DEFAULT_LIMIT).toBeGreaterThan(0);
  });

  it("returns an empty array when nothing is recorded", () => {
    expect(listRecentAuditEvents(ctx.makeDb())).toEqual([]);
  });
});
