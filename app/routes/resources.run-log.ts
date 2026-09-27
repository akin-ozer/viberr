import type { Route } from "./+types/resources.run-log";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { authenticate } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  runLogPage,
  type RunLogQuery,
} from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { runLogWindowFor } from "~/server/runtimes/run-projection.server";

/**
 * GET /resources/run-log?runId=<id> — a page of a run's log lines. Two modes:
 *
 *   ?since=<seq>            forward tail: everything after `seq` (default -1 =
 *                           all). The dedicated logs consumer calls this after
 *                           a `run.log-appended` SSE event, so the payload
 *                           stays a compact reference on the wire and content
 *                           is fetched on demand (docs/architecture/decisions.md forbids fat SSE
 *                           objects).
 *   ?window=1               the console window of the run's agent group
 *                           (ruling 457): display lines with their keys,
 *                           the window facts and the representative's live
 *                           facts, as a hard refresh ships the shown group.
 *                           No envelopes.
 *   ?raw=0                  (with `since` or `before`) leaves each line's
 *                           stored envelope out (ruling 457).
 *   ?before=<seq>&limit=<n> backward page (P13-D-11): the newest `n` lines
 *                           OLDER than `seq`. The task loader now ships a
 *                           bounded window of each agent group's console
 *                           (NFR5), and this is how the console walks back
 *                           through the history it did not ship. `hasMore`,
 *                           `headSeq` and `oldestSeq` are PAGE-LOCAL cursors
 *                           for this stateful console (ruling 107 disowned
 *                           them as facts about the run): `hasMore: false`
 *                           means this page reached the run's oldest line —
 *                           the console then steps to the previous run id in
 *                           the group's `logWindow.runIds` and pages ITS tail
 *                           (`before` omitted). A model reading a run goes
 *                           through `viberr_ops.read_run_log`, which reports
 *                           the run's REAL bounds instead.
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
  // Ruling 457 (test audit L14-29): a 401, never `requireUser`'s login
  // redirect. The run console reads this in the background with a plain
  // `fetch`, which follows a redirect without a word: every tail read from a
  // signed-out tab rendered /login on the server, failed to parse as the log,
  // and was retried in silence. The console now says its tail stopped, and the
  // page's next real navigation asks for the sign-in.
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    return Response.json(
      {
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: "Sign in to read this run's log.",
        },
      },
      { status: 401 },
    );
  }
  const { user } = ctx;
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return Response.json(
      { error: { code: ERROR_CODES.VALIDATION_FAILED, message: "runId is required." } },
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
  // Ruling 99: a controller conversation turn has no project scope — its log
  // is readable by the conversation's OWNER (and org admins), never by
  // project membership.
  if (run.kind === "controller") {
    const { canReadControllerRunLog } = await import(
      "~/server/controller/controller-conversations.server"
    );
    if (!canReadControllerRunLog(db, run, { id: user.id })) {
      return Response.json(
        { error: { code: "not_found", message: `Run ${runId} not found.` } },
        { status: 404 },
      );
    }
  } else {
    // Membership gate for the run's project (throws a 403 Response for non-members).
    await requireProjectMember(request, run.project_slug, "view raw run logs");
  }

  // Ruling 457 (owner decision 2): the whole console window of the run's
  // agent group, exactly as a hard refresh would ship it. Pages carry no
  // console lines on a revalidation or a client navigation, so the console
  // fills the thread it shows with this one request.
  if (url.searchParams.get("window") === "1") {
    return Response.json({ data: runLogWindowFor(db, run) });
  }

  // Backward mode is selected by the PRESENCE of `before`/`limit`, so an
  // absent param must leave its key off entirely rather than carry undefined.
  let query: RunLogQuery;
  if (before !== null || limit !== null) {
    query = {};
    if (before !== null) query.before = before;
    if (limit !== null) query.limit = limit;
  } else {
    query = { since };
  }
  // The row read above, not a second read: the live tail calls this once per
  // streamed line per viewer (ruling 457).
  const page = runLogPage(db, run, query);
  // Ruling 457: `raw=0` leaves the stored envelopes out; the console asks for
  // them only while its raw view is open, and they are most of a line's bytes.
  if (url.searchParams.get("raw") === "0") {
    return Response.json({
      data: { ...page, lines: page.lines.map(({ raw: _raw, ...line }) => line) },
    });
  }
  return Response.json({ data: page });
}
