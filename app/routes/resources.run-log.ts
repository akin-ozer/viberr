import type { Route } from "./+types/resources.run-log";
import { requireUser } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getRunLog } from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";

/**
 * GET /resources/run-log?runId=<id> — a page of a run's log lines. Two modes:
 *
 *   ?since=<seq>            forward tail: everything after `seq` (default -1 =
 *                           all). The dedicated logs consumer calls this after
 *                           a `run.log-appended` SSE event, so the payload
 *                           stays a compact reference on the wire and content
 *                           is fetched on demand (docs/architecture/decisions.md forbids fat SSE
 *                           objects).
 *   ?before=<seq>&limit=<n> backward page (P13-D-11): the newest `n` lines
 *                           OLDER than `seq`. The task loader now ships a
 *                           bounded window of each agent group's console
 *                           (NFR5), and this is how the console walks back
 *                           through the history it did not ship. When a page
 *                           comes back with `hasMore: false` the run is
 *                           exhausted — step to the previous run id in that
 *                           group's `logWindow.runIds` and page ITS tail
 *                           (`before` omitted).
 *
 * F10-06/F10-33: raw run logs are SENSITIVE — they carry tool output, agent
 * prompts, repository metadata, and possibly secrets. (P13-U-1 now scrubs the
 * credentials this app itself injects, plus token-shaped strings, at the sink —
 * a filter, not a guarantee.) The app-wide task view (FR4) exposes the task
 * summary, timeline, and comments, but NOT raw run content. So this route
 * authorizes PROJECT MEMBERSHIP (org admins pass via the D2 override), unlike
 * the old "any signed-in user may read" behavior. This is the same guard the
 * config routes and SSE topics use.
 *
 * Returns `{ data: { runId, threadId, state, headSeq, oldestSeq, hasMore,
 * lines: [{ seq, occurredAt, raw, display }] } }`.
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
  const intParam = (name: string): number | null => {
    const raw = url.searchParams.get(name);
    return raw !== null && /^-?\d+$/.test(raw) ? Number(raw) : null;
  };
  const since = intParam("since") ?? -1;
  const before = intParam("before");
  // P13-D-11: a client-named page size, clamped — an unbounded `limit` would
  // hand back the very payload this endpoint exists to page.
  const limitRaw = intParam("limit");
  const limit = limitRaw === null ? null : Math.min(Math.max(limitRaw, 1), 500);

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

  const log = getRunLog(
    db,
    runId,
    before !== null || limit !== null
      ? {
          ...(before !== null ? { before } : {}),
          ...(limit !== null ? { limit } : {}),
        }
      : { since },
  );
  if (!log) {
    return Response.json(
      { error: { code: "not_found", message: `Run ${runId} not found.` } },
      { status: 404 },
    );
  }
  return Response.json({ data: log });
}
