import type { Route } from "./+types/resources.run-log";
import { requireUser } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getRunLog } from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";

/**
 * GET /resources/run-log?runId=<id>&since=<seq> — the tail of a run's log
 * lines since `seq` (default -1 = all). The dedicated logs consumer calls
 * this after a `run.log-appended` SSE event, so the payload stays a compact
 * reference on the wire and content is fetched on demand (CONVENTIONS forbids
 * fat SSE objects).
 *
 * F10-06/F10-33: raw run logs are SENSITIVE — they carry tool output, agent
 * prompts, repository metadata, and possibly secrets. The app-wide task view
 * (FR4) exposes the task summary, timeline, and comments, but NOT raw run
 * content. So this route authorizes PROJECT MEMBERSHIP (org admins pass via the
 * D2 override), unlike the old "any signed-in user may read" behavior. This is
 * the same guard the config routes and SSE topics use.
 *
 * Returns `{ data: { runId, threadId, state, headSeq, lines: [{ seq,
 * occurredAt, raw, display }] } }`.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return Response.json(
      { error: { code: "validation", message: "runId is required." } },
      { status: 400 },
    );
  }
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw !== null && /^-?\d+$/.test(sinceRaw) ? Number(sinceRaw) : -1;

  const db = getDb();
  const run = getRun(db, runId);
  if (!run) {
    return Response.json(
      { error: { code: "not_found", message: `Run ${runId} not found.` } },
      { status: 404 },
    );
  }
  // Membership gate for the run's project (throws a 403 Response for non-members).
  await requireProjectMember(request, run.project_slug, "view raw run logs");

  const log = getRunLog(db, runId, since);
  if (!log) {
    return Response.json(
      { error: { code: "not_found", message: `Run ${runId} not found.` } },
      { status: 404 },
    );
  }
  return Response.json({ data: log });
}
