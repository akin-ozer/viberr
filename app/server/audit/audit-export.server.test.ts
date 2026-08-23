import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  auditRowsToCsv,
  auditRowsToJson,
  queryAuditEventsForExport,
  serializeAuditExport,
  type AuditExportRow,
} from "./audit-export.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ROW: AuditExportRow = {
  id: "aud_1",
  occurredAt: "2026-08-23T10:00:00.000Z",
  actorUserId: "u_1",
  actorLabel: "arda@viberr.dev",
  action: "task.metadata.updated",
  subjectKind: "task",
  subjectId: "VIB-1",
  projectSlug: "viberr-core",
  taskKey: "VIB-1",
  detailsJson: '{"priority":"high"}',
};

describe("CSV serialization", () => {
  it("writes a header and RFC-4180-escaped rows", () => {
    const csv = auditRowsToCsv([ROW]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "id,occurredAt,actorUserId,actorLabel,action,subjectKind,subjectId,projectSlug,taskKey,details",
    );
    // The details JSON contains a comma and quotes → wrapped + quotes doubled.
    expect(lines[1]).toBe(
      'aud_1,2026-08-23T10:00:00.000Z,u_1,arda@viberr.dev,task.metadata.updated,task,VIB-1,viberr-core,VIB-1,"{""priority"":""high""}"',
    );
  });

  it("escapes commas, quotes and newlines in a label", () => {
    const csv = auditRowsToCsv([
      { ...ROW, actorLabel: 'a, "b"\nc', detailsJson: null },
    ]);
    expect(csv).toContain('"a, ""b""\nc"');
    // A null details cell is empty, not the string "null".
    expect(csv.trimEnd().endsWith(",")).toBe(true);
  });
});

describe("JSON serialization", () => {
  it("inlines valid details as a parsed object", () => {
    const parsed = JSON.parse(auditRowsToJson([ROW]));
    expect(parsed[0].details).toEqual({ priority: "high" });
    expect(parsed[0].action).toBe("task.metadata.updated");
  });

  it("preserves un-parseable details under detailsRaw", () => {
    const parsed = JSON.parse(
      auditRowsToJson([{ ...ROW, detailsJson: "{not json" }]),
    );
    expect(parsed[0].detailsRaw).toBe("{not json");
    expect(parsed[0].details).toBeUndefined();
  });

  it("null details serialize as null", () => {
    const parsed = JSON.parse(auditRowsToJson([{ ...ROW, detailsJson: null }]));
    expect(parsed[0].details).toBeNull();
  });
});

describe("serializeAuditExport dispatch", () => {
  it("routes to csv/json by format", () => {
    expect(serializeAuditExport([ROW], "csv")).toContain("id,occurredAt");
    expect(serializeAuditExport([ROW], "json")).toContain('"action"');
  });
});

describe("queryAuditEventsForExport", () => {
  // Insert directly so occurred_at is controlled (recordAudit stamps "now").
  function insert(
    db: DatabaseSync,
    row: {
      id: string;
      occurredAt: string;
      actorUserId: string;
      action: string;
      projectSlug: string;
      detailsJson: string | null;
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
      row.actorUserId,
      row.actorUserId,
      row.action,
      "VIB-1",
      row.projectSlug,
      "VIB-1",
      row.detailsJson,
    );
  }
  function seed() {
    const db = ctx.makeDb();
    insert(db, {
      id: "a1",
      occurredAt: "2026-08-20T00:00:00.000Z",
      actorUserId: "u_1",
      action: "task.created",
      projectSlug: "viberr-core",
      detailsJson: null,
    });
    insert(db, {
      id: "a2",
      occurredAt: "2026-08-22T00:00:00.000Z",
      actorUserId: "u_2",
      action: "task.metadata.updated",
      projectSlug: "other-project",
      detailsJson: '{"priority":"urgent"}',
    });
    return db;
  }

  it("returns rows newest-first with the details JSON verbatim", () => {
    const db = seed();
    const rows = queryAuditEventsForExport(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe("task.metadata.updated"); // newest first
    expect(rows[0]?.detailsJson).toContain("urgent");
  });

  it("filters by project, action and date range", () => {
    const db = seed();
    expect(
      queryAuditEventsForExport(db, { projectSlug: "other-project" }),
    ).toHaveLength(1);
    expect(
      queryAuditEventsForExport(db, { action: "task.created" }),
    ).toHaveLength(1);
    expect(
      queryAuditEventsForExport(db, { since: "2026-08-21T00:00:00.000Z" }),
    ).toHaveLength(1);
    expect(
      queryAuditEventsForExport(db, { until: "2026-08-21T00:00:00.000Z" }),
    ).toHaveLength(1);
    expect(queryAuditEventsForExport(db, { actorUserId: "u_2" })).toHaveLength(1);
  });
});
