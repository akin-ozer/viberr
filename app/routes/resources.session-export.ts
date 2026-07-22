import type { Route } from "./+types/resources.session-export";
import { requireUser } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import {
  buildResumeScript,
  locateTranscript,
} from "~/server/runtimes/session-export.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * GET /resources/session-export?run=<runId>
 *
 * Downloads a self-contained bash installer that carries the run's provider
 * session transcript and, when run on the user's machine, drops it where the
 * local CLI looks for it and prints the exact resume command
 * (`claude --resume <id>` / `codex resume <id>`) — so a conversation started
 * inside Viberr can be continued locally on the same subscription. See
 * session-export.server.ts for the resume mechanics.
 *
 * 404 when the run has no resumable on-disk provider session.
 *
 * F10-06/F10-33: a provider session transcript is the MOST sensitive run
 * artifact (full conversation, tool outputs, repository content, prompts, and
 * potentially secrets) AND it is a downloadable installer. So — unlike the old
 * "any signed-in user" behavior — this requires PROJECT MEMBERSHIP (org admins
 * pass via the D2 override). The app-wide task view never implied transcript
 * export.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const db = getDb();
  const runId = new URL(request.url).searchParams.get("run");
  if (!runId) {
    return new Response("Missing ?run=<runId>.", { status: 400 });
  }
  const run = getRun(db, runId);
  if (!run) {
    return new Response("Run not found.", { status: 404 });
  }
  // Membership gate for the run's project (throws a 403 Response for non-members).
  await requireProjectMember(request, run.project_slug, "export the provider session");
  if (!run.session_id) {
    return new Response(
      "This run never opened an exportable provider session.",
      { status: 404 },
    );
  }
  const backend: RealBackend = run.backend === "codex" ? "codex" : "claude";
  const located = locateTranscript(backend, run.session_id);
  if (!located) {
    return new Response(
      `No ${backend} session transcript found on disk for ${run.session_id}. ` +
        "It may have been created before session persistence was configured, or pruned.",
      { status: 404 },
    );
  }

  const task = getTaskSummary(db, run.project_slug, run.task_key);
  const { filename, body } = buildResumeScript(located, {
    taskKey: run.task_key,
    taskTitle: task?.title,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-sh; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
