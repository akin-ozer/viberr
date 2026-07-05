import type { Route } from "./+types/resources.run-log";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getRunLog } from "~/server/runtimes/run-service.server";

/**
 * GET /resources/run-log?runId=<id>&since=<seq> — the tail of a run's log
 * lines since `seq` (default -1 = all). The dedicated logs consumer calls
 * this after a `run.log-appended` SSE event, so the payload stays a compact
 * reference on the wire and content is fetched on demand (CONVENTIONS forbids
 * fat SSE objects). Any signed-in user may read (V1 read RBAC: all app users
 * see all projects; interrupting is the gated action, not viewing).
 *
 * Returns `{ data: { runId, threadId, state, headSeq, lines: [{ seq,
 * occurredAt, raw, display }] } }`.
 */
export async function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
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

  const log = getRunLog(getDb(), runId, since);
  if (!log) {
    return Response.json(
      { error: { code: "not_found", message: `Run ${runId} not found.` } },
      { status: 404 },
    );
  }
  return Response.json({ data: log });
}
