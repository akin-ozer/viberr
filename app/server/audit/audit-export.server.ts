import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Audit-log EXPORT: the compliance read that hands the raw `audit_events` table
 * out as CSV or JSON. Distinct from `activity-feed.server.ts` (the whitelisted,
 * templated, project-scoped DISPLAY feed) — an export is the full recorded fact
 * for every row, for an admin taking the log off the box. Org-admin gated at the
 * route; nothing here checks auth.
 */

/** Hard ceiling on rows per export — a guard so a single download can't try to
 *  materialize an unbounded table into one string. F26-9: the Audit-log panel copy
 *  (org-settings-page.tsx) discloses this cap AND the 90-day retention window, so
 *  "the full log" is never claimed where both silently bound it. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

export interface AuditExportFilters {
  /** Restrict to one project (null/absent → every project, incl. instance rows). */
  projectSlug?: string;
  /** Exact action match (e.g. "task.metadata.updated"). */
  action?: string;
  /** Restrict to one actor. */
  actorUserId?: string;
  /** ISO lower bound on occurred_at (inclusive). */
  since?: string;
  /** ISO upper bound on occurred_at (inclusive). */
  until?: string;
  /** Row cap; clamped to [1, AUDIT_EXPORT_MAX_ROWS]. */
  limit?: number;
}

export interface AuditExportRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  subjectKind: string | null;
  subjectId: string | null;
  projectSlug: string | null;
  taskKey: string | null;
  /** The raw details JSON string as stored (null when the row carried none). */
  detailsJson: string | null;
}

const rowSchema = z.object({
  id: z.string(),
  occurred_at: z.string(),
  actor_user_id: z.string().nullable(),
  actor_label: z.string(),
  action: z.string(),
  subject_kind: z.string().nullable(),
  subject_id: z.string().nullable(),
  project_slug: z.string().nullable(),
  task_key: z.string().nullable(),
  details_json: z.string().nullable(),
});

/**
 * Read audit rows for export, newest first, under a hard row cap. Every filter
 * is an optional AND-clause bound through a placeholder — no value is ever
 * interpolated into the SQL text.
 */
export function queryAuditEventsForExport(
  db: DatabaseSync,
  filters: AuditExportFilters = {},
): AuditExportRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.projectSlug) {
    where.push("project_slug = ?");
    params.push(filters.projectSlug);
  }
  if (filters.action) {
    where.push("action = ?");
    params.push(filters.action);
  }
  if (filters.actorUserId) {
    where.push("actor_user_id = ?");
    params.push(filters.actorUserId);
  }
  if (filters.since) {
    where.push("occurred_at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    where.push("occurred_at <= ?");
    params.push(filters.until);
  }
  const limit = Math.max(
    1,
    Math.min(AUDIT_EXPORT_MAX_ROWS, Math.floor(filters.limit ?? AUDIT_EXPORT_MAX_ROWS)),
  );
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = z.array(rowSchema).parse(
    db
      .prepare(
        `SELECT * FROM audit_events ${clause}
         ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit),
  );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    actorUserId: r.actor_user_id,
    actorLabel: r.actor_label,
    action: r.action,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    projectSlug: r.project_slug,
    taskKey: r.task_key,
    detailsJson: r.details_json,
  }));
}

/** The column order both serializers use — stable, so a downstream parser can
 *  rely on it. `details` carries the raw JSON string verbatim. */
const COLUMNS = [
  "id",
  "occurredAt",
  "actorUserId",
  "actorLabel",
  "action",
  "subjectKind",
  "subjectId",
  "projectSlug",
  "taskKey",
  "details",
] as const;

function cellFor(row: AuditExportRow, column: (typeof COLUMNS)[number]): string {
  if (column === "details") return row.detailsJson ?? "";
  const value = row[column];
  return value ?? "";
}

/** RFC 4180 escaping (comma / quote / CR / LF → wrapped + quotes doubled), with
 *  F26-10 formula-injection neutralization first: a cell beginning with `= + - @`
 *  (or a leading tab/CR) is a live formula in Excel/Sheets on open, so prefix a
 *  single quote to force it to render literally. This matters because `actorLabel`
 *  is a user-supplied email and the email validator permits a leading `+`/`-`, so
 *  a crafted signup could land a formula in an admin's spreadsheet. */
function csvField(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/** Serialize rows to CSV with a header line and CRLF terminators (RFC 4180). */
export function auditRowsToCsv(rows: readonly AuditExportRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => csvField(cellFor(row, c))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** One row of the JSON export. `details` is the parsed details tree (or null);
 *  `detailsRaw` carries the original string when it would not parse. */
interface AuditExportJsonRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  subjectKind: string | null;
  subjectId: string | null;
  projectSlug: string | null;
  taskKey: string | null;
  details?: unknown;
  detailsRaw?: string;
}

/** Serialize rows to a JSON array. `details` is inlined as PARSED JSON when it
 *  is valid (so the export is a real object tree, not a string-of-JSON), else
 *  the raw string is preserved under `detailsRaw`. */
export function auditRowsToJson(rows: readonly AuditExportRow[]): string {
  const out = rows.map((row) => {
    const base: AuditExportJsonRow = {
      id: row.id,
      occurredAt: row.occurredAt,
      actorUserId: row.actorUserId,
      actorLabel: row.actorLabel,
      action: row.action,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      projectSlug: row.projectSlug,
      taskKey: row.taskKey,
    };
    if (row.detailsJson) {
      try {
        base.details = JSON.parse(row.detailsJson);
      } catch {
        base.detailsRaw = row.detailsJson;
      }
    } else {
      base.details = null;
    }
    return base;
  });
  return JSON.stringify(out, null, 2);
}

/** The MIME + extension for a chosen format, for the download route's headers. */
export const EXPORT_FORMATS = {
  csv: { contentType: "text/csv; charset=utf-8", ext: "csv" },
  json: { contentType: "application/json; charset=utf-8", ext: "json" },
} as const;

export type AuditExportFormat = keyof typeof EXPORT_FORMATS;

export function isAuditExportFormat(value: string): value is AuditExportFormat {
  return value === "csv" || value === "json";
}

/** Serialize rows to the chosen format. */
export function serializeAuditExport(
  rows: readonly AuditExportRow[],
  format: AuditExportFormat,
): string {
  return format === "csv" ? auditRowsToCsv(rows) : auditRowsToJson(rows);
}
