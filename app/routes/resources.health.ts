import { data } from "react-router";
import { getDb } from "~/server/db/sqlite.server";
import { isFileWatcherAlive } from "~/server/files/file-watch.service.server";
import { logger } from "~/server/logging/logger.server";
import { isBackendAvailable } from "~/server/runtimes/runtime-registry.server";

/**
 * GET /resources/health — ops probe (Phase 10, CONVENTIONS route map).
 * Unauthenticated by design (readiness checks run without a session);
 * exposes only aggregate counts, never data.
 *
 * 200 `{ ok, projections: { projects, tasks }, watcher, backends }` when the
 * database answers; `watcher` is true while the in-process store watcher is
 * running — a chokidar error clears the watcher handle (E8), so false here
 * is REAL (dead watcher), not just "never started". `backends.{claude,codex}`
 * reports whether a real credential is configured (env-presence only — NOT a
 * validity check; an expired token still reads "real"): "real" means runs
 * execute the SDK, "unavailable" means runs on that backend FAIL FAST with an
 * honest error (R7-2 — there is no simulated fallback). This is
 * how you confirm, e.g. via `docker compose logs` / a curl, that a Claude
 * key/token reached the container.
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
      backends: {
        // Env-presence only — never probes token validity (see docblock).
        claude: isBackendAvailable("claude") ? "real" : "unavailable",
        codex: isBackendAvailable("codex") ? "real" : "unavailable",
      },
    });
  } catch (error) {
    logger.error("health check failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return data({ ok: false as const }, { status: 503 });
  }
}
