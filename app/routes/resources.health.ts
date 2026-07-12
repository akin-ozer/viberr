import { data } from "react-router";
import { getDb } from "~/server/db/sqlite.server";
import { isFileWatcherAlive } from "~/server/files/file-watch.service.server";
import { logger } from "~/server/logging/logger.server";
import { getBackendHealth } from "~/server/runtimes/runtime-registry.server";
import {
  checkDatabaseIntegrity,
  getDatabaseIntegrityIncident,
  ProjectionIntegrityError,
} from "~/server/db/database-integrity.server";

/**
 * GET /resources/health — ops probe (Phase 10, CONVENTIONS route map).
 * Unauthenticated by design (readiness checks run without a session);
 * exposes only aggregate counts, never data.
 *
 * 200 `{ ok, projections: { projects, tasks }, watcher, backends }` when the
 * database answers; `watcher` is true while the in-process store watcher is
 * running — a chokidar error clears the watcher handle (E8), so false here
 * is REAL (dead watcher), not just "never started". `backends.{claude,codex}`
 * separates credential/CLI-auth presence (`configured`) from a recent usable
 * signal (`verified`) and a recent failed real run (`degraded`). `unknown`
 * means configured but not recently exercised. Reads never call a provider;
 * real run results feed this small process-local cache.
 * 503 `{ ok: false }` when the database cannot be read.
 */
export async function loader() {
  const bootIncident = getDatabaseIntegrityIncident();
  if (bootIncident) {
    return data(
      {
        ok: false as const,
        integrity: {
          ok: false as const,
          recoveryRequired: true as const,
          summary: bootIncident.message,
        },
      },
      { status: 503 },
    );
  }
  try {
    const db = getDb();
    const integrity = checkDatabaseIntegrity(db);
    if (!integrity.ok) throw new ProjectionIntegrityError(integrity);
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
      integrity: { ok: true as const, recoveryRequired: false as const },
      projections: { projects, tasks },
      watcher: isFileWatcherAlive(),
      backends: {
        claude: getBackendHealth("claude"),
        codex: getBackendHealth("codex"),
      },
    });
  } catch (error) {
    logger.error("health check failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return data(
      {
        ok: false as const,
        integrity: {
          ok: false as const,
          recoveryRequired: error instanceof ProjectionIntegrityError,
          summary:
            error instanceof ProjectionIntegrityError
              ? error.message
              : "The projection database could not be read.",
        },
      },
      { status: 503 },
    );
  }
}
