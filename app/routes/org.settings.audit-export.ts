import { getDb } from "~/server/db/sqlite.server";
import { requireRole } from "~/server/auth/require-user.server";
import {
  EXPORT_FORMATS,
  isAuditExportFormat,
  queryAuditEventsForExport,
  serializeAuditExport,
  type AuditExportFilters,
} from "~/server/audit/audit-export.server";

/**
 * GET /org/settings/audit-export?format=csv|json&project=…&action=…&since=…&until=…
 *
 * Downloads the audit log as a file. Org-admin gated (requireRole), same as the
 * settings page it is launched from. Filters are optional query params; the
 * body is streamed with a Content-Disposition so the browser saves it.
 */
export async function loader({ request }: { request: Request }) {
  // Org-admin only. Throws a redirect/403 for anyone else.
  await requireRole(request, "admin");

  const url = new URL(request.url);
  const formatRaw = url.searchParams.get("format") ?? "csv";
  const format = isAuditExportFormat(formatRaw) ? formatRaw : "csv";

  const filters: AuditExportFilters = {};
  const project = url.searchParams.get("project");
  const action = url.searchParams.get("action");
  const actor = url.searchParams.get("actor");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  if (project) filters.projectSlug = project;
  if (action) filters.action = action;
  if (actor) filters.actorUserId = actor;
  if (since) filters.since = since;
  if (until) filters.until = until;

  const rows = queryAuditEventsForExport(getDb(), filters);
  const body = serializeAuditExport(rows, format);
  const spec = EXPORT_FORMATS[format];
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": spec.contentType,
      "Content-Disposition": `attachment; filename="viberr-audit-${stamp}.${spec.ext}"`,
      "Cache-Control": "no-store",
    },
  });
}
