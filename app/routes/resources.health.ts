import { data } from "react-router";
import { getDb } from "~/server/db/sqlite.server";
import { isFileWatcherAlive } from "~/server/files/file-watch.service.server";
import { logger } from "~/server/logging/logger.server";

/**
 * GET /resources/health — ops probe (Phase 10, CONVENTIONS route map).
 * Unauthenticated by design (readiness checks run without a session);
 * exposes only aggregate counts, never data.
 *
 * 200 `{ ok: true, projections: { projects, tasks }, watcher }` when the
 * database answers; `watcher` is true while the in-process store watcher is
 * running (false = projections only converge via manual re-scan).
 * 503 `{ ok: false }` when the database cannot be read.
 */
export async function loader() {
  try {
    const db = getDb();
    const projects = (
      db.prepare(`SELECT count(*) AS c FROM projects`).get() as { c: number }
    ).c;
    const tasks = (
      db.prepare(`SELECT count(*) AS c FROM task_projections`).get() as {
        c: number;
      }
    ).c;
    return data({
      ok: true as const,
      projections: { projects, tasks },
      watcher: isFileWatcherAlive(),
    });
  } catch (error) {
    logger.error("health check failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return data({ ok: false as const }, { status: 503 });
  }
}
