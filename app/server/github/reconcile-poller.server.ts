import type { DatabaseSync } from "node:sqlite";
import { SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import {
  reconcileProject,
  type GithubActionContext,
} from "./github-reconciler.server";

/**
 * Background PR-status poller (P11-14, owner ruling 2026-07-24). The R8-6
 * divergence reconciler (a PR merged/closed out-of-band) used to run ONLY when a
 * maintainer clicked the manual button, so out-of-band GitHub changes went
 * unnoticed indefinitely. This polls every ACTIVE (non-archived) project that has
 * task branches, every 5 minutes, so the divergence event + watcher notification
 * + recommendation-withdrawal fire automatically. Poller ticks suppress the
 * per-project summary audit (`skipProjectAudit`) to avoid audit-log spam; the
 * meaningful per-task divergence events still fire, and the manual "Update
 * status" button keeps its human audit.
 */

export const RECONCILE_POLL_MS = 5 * 60_000; // 5 minutes

/** Active projects that have at least one branched task worth reconciling. */
function projectsToPoll(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT t.project_slug AS slug
           FROM task_projections t
           JOIN projects p ON p.slug = t.project_slug
          WHERE t.branch IS NOT NULL AND p.archived = 0
          ORDER BY t.project_slug ASC`,
      )
      .all() as { slug: string }[]
  ).map((r) => r.slug);
}

/**
 * One poll pass: reconcile every active branched project. Best-effort per
 * project — one project's GitHub failure never aborts the others. Returns a
 * summary for logging/tests.
 */
export async function pollGithubReconcile(
  db: DatabaseSync,
  ctx: GithubActionContext = {},
): Promise<{ projects: number; reconciled: number; changed: number }> {
  const slugs = projectsToPoll(db);
  let reconciled = 0;
  let changed = 0;
  for (const slug of slugs) {
    try {
      const summary = await reconcileProject(db, slug, SYSTEM_ACTOR, {
        ...ctx,
        skipProjectAudit: true,
      });
      reconciled += summary.reconciled;
      changed += summary.changed;
    } catch (error) {
      logger.warn("github reconcile poll failed for a project", {
        projectSlug: slug,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  if (changed > 0) {
    logger.info("github reconcile poll surfaced changes", {
      projects: slugs.length,
      reconciled,
      changed,
    });
  }
  return { projects: slugs.length, reconciled, changed };
}

// HMR-safe singleton — the repo convention (boot, file-watch, kb-watch):
// module state resets on a dev reload, so a module-scoped handle would let a
// re-evaluated module stack a second interval next to the orphaned first. The
// handle lives behind a global symbol instead, making a repeat start() a true
// no-op — no duplicate interval and no re-fired boot poll.
const POLLER_KEY = Symbol.for("viberr.githubReconcilePoller");

function pollerCache(): Record<symbol, ReturnType<typeof setInterval> | undefined> {
  return globalThis as unknown as Record<
    symbol,
    ReturnType<typeof setInterval> | undefined
  >;
}

/**
 * Start the poller: run once at boot (catch out-of-band changes that landed
 * while the process was down), then every RECONCILE_POLL_MS. Non-overlapping (a
 * slow tick can't stack), unref'd (never keeps the process alive), idempotent.
 */
export function startGithubReconcilePoller(db: DatabaseSync): void {
  const cache = pollerCache();
  if (cache[POLLER_KEY]) return;
  void pollGithubReconcile(db).catch(() => {});
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void pollGithubReconcile(db)
      .catch((error) => {
        logger.warn("github reconcile poller tick failed", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        running = false;
      });
  }, RECONCILE_POLL_MS);
  if (typeof handle.unref === "function") handle.unref();
  cache[POLLER_KEY] = handle;
}

/** Stop the poller (tests + graceful shutdown). */
export function stopGithubReconcilePoller(): void {
  const cache = pollerCache();
  const handle = cache[POLLER_KEY];
  if (handle) {
    clearInterval(handle);
    cache[POLLER_KEY] = undefined;
  }
}
