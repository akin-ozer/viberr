import path from "node:path";
import type Database from "better-sqlite3";
import { watch, type FSWatcher } from "chokidar";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath, rebuildTaskFile } from "~/server/projections/rebuilder.server";
import { getDataRoot, projectFilePath, projectsDir, taskFilePath } from "./file-store-root.server";
import { createPathDebouncer, type PathDebouncer } from "./path-debounce.server";

/**
 * File watcher: chokidar (v5) on the ${dataRoot}/projects tree, driving
 * single-file incremental projection rebuilds.
 *
 * - 250 ms trailing debounce per path (editors fire bursts of events);
 * - ignores dotfiles and `*.tmp` (our atomic-write staging files);
 * - handles `unlinkDir` (E13): a recursive rm can delete a task/project
 *   directory faster than chokidar reports the per-file unlinks, which used
 *   to leave orphaned projection rows until the next manual rescan. A
 *   removed task dir reprojects that task (→ removed); a removed project
 *   dir (or tasks/ dir) reconciles the whole project against disk;
 * - a chokidar `error` CLEARS the cached handle (E8): the watcher is no
 *   longer trusted to deliver events, so `isFileWatcherAlive` — and the
 *   /resources/health `watcher` field — reports false instead of a zombie;
 * - started from server boot in dev AND prod;
 * - HMR-safe: the watcher handle lives behind a global symbol — a module
 *   reload reuses the running watcher instead of stacking a duplicate.
 */

export const WATCH_DEBOUNCE_MS = 250;

const WATCHER_KEY = Symbol.for("viberr.fileWatcher");

interface WatcherHandle {
  watcher: FSWatcher;
  debouncer: PathDebouncer;
  dirDebouncer: PathDebouncer;
  root: string;
}

function shouldIgnore(candidate: string): boolean {
  const base = path.basename(candidate);
  return base.startsWith(".") || base.endsWith(".tmp");
}

/** Starts (or returns the already-running) projects-tree watcher. */
export function startFileWatcher(
  options: { dataRoot?: string; db?: Database.Database } = {},
): FSWatcher {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  const root = getDataRoot(options.dataRoot);
  const existing = cache[WATCHER_KEY];
  if (existing && existing.root === root) return existing.watcher;
  if (existing) {
    // Data root changed (tests) — retire the old watcher first.
    existing.debouncer.cancelAll();
    existing.dirDebouncer.cancelAll();
    void existing.watcher.close();
  }

  const resolveDb = () => options.db ?? getDb();
  const watchedDir = projectsDir(options.dataRoot);
  const debouncer = createPathDebouncer(WATCH_DEBOUNCE_MS, (absPath) => {
    try {
      const result = rebuildPath(resolveDb(), absPath, { dataRoot: root });
      if (result.action !== "ignored" && result.action !== "unchanged") {
        logger.info("watcher reprojected file", {
          path: absPath,
          action: result.action,
          projectSlug: result.projectSlug,
          taskKey: result.taskKey,
        });
      }
    } catch (error) {
      logger.error("watcher rebuild failed", {
        path: absPath,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });

  /**
   * E13 — a directory vanished. Map it onto the projection rows it backed:
   *   projects/<slug>                → reconcile the whole project
   *   projects/<slug>/tasks          → reconcile the whole project
   *   projects/<slug>/tasks/<KEY>    → reproject that task (file gone → removed)
   * Deeper paths (a task's workspace/, attachments/…) carry no projection
   * rows — ignored. The projects ROOT itself unlinking reconciles every
   * projected project.
   */
  const dirDebouncer = createPathDebouncer(WATCH_DEBOUNCE_MS, (absDir) => {
    try {
      const db = resolveDb();
      const rel = path.relative(watchedDir, absDir);
      if (rel.startsWith("..")) return;
      const segments = rel === "" ? [] : rel.split(path.sep);

      const reconcileProject = (slug: string) => {
        // project.md path routes through the normal removal handling…
        rebuildPath(db, projectFilePath(slug, root), { dataRoot: root });
        // …and every projected task is checked against disk (a project-row
        // removal does NOT cascade to task rows — prune them explicitly).
        const tasks = db
          .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
          .all(slug) as { task_key: string }[];
        for (const t of tasks) {
          rebuildTaskFile(db, slug, t.task_key, { dataRoot: root });
        }
        logger.info("watcher reconciled removed directory", {
          path: absDir,
          projectSlug: slug,
        });
      };

      if (segments.length === 0) {
        // The projects root itself vanished — reconcile everything projected.
        const slugs = db.prepare(`SELECT slug FROM projects`).all() as {
          slug: string;
        }[];
        for (const row of slugs) reconcileProject(row.slug);
        return;
      }
      const slug = segments[0]!;
      if (segments.length === 1) return reconcileProject(slug);
      if (segments[1] !== "tasks") return; // non-store subtree
      if (segments.length === 2) return reconcileProject(slug);
      if (segments.length === 3) {
        // Single task dir: task.md is gone with it → projects the removal.
        debouncer.schedule(path.resolve(taskFilePath(slug, segments[2]!, root)));
      }
      // Deeper than the task dir: nothing projected lives there.
    } catch (error) {
      logger.error("watcher directory reconcile failed", {
        path: absDir,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });

  const watcher = watch(watchedDir, {
    ignoreInitial: true,
    ignored: (candidate: string) => shouldIgnore(candidate),
  });

  const schedule = (absPath: string) => {
    if (shouldIgnore(absPath)) return;
    const base = path.basename(absPath);
    if (base !== "project.md" && base !== "task.md") return;
    debouncer.schedule(path.resolve(absPath));
  };

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  watcher.on("unlinkDir", (absDir: string) => {
    if (shouldIgnore(absDir)) return;
    dirDebouncer.schedule(path.resolve(absDir));
  });
  watcher.on("error", (error) => {
    // E8: the handle can no longer be trusted to deliver events — clear it so
    // isFileWatcherAlive() (and /resources/health) reports the truth instead
    // of a zombie watcher. The next boot (or test restart) re-creates it.
    logger.error("file watcher error — clearing watcher handle", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    const current = cache[WATCHER_KEY];
    if (current && current.watcher === watcher) {
      current.debouncer.cancelAll();
      current.dirDebouncer.cancelAll();
      cache[WATCHER_KEY] = undefined;
    }
    void watcher.close();
  });

  cache[WATCHER_KEY] = { watcher, debouncer, dirDebouncer, root };
  logger.info("file watcher started", { dir: watchedDir, debounceMs: WATCH_DEBOUNCE_MS });
  return watcher;
}

/** True while a store watcher is running in this process (health route).
 * A chokidar error clears the handle, so this reflects real liveness. */
export function isFileWatcherAlive(): boolean {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  return cache[WATCHER_KEY] !== undefined;
}

/** Test-only: stop and forget the running watcher. */
export function stopFileWatcherForTests(): void {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  const existing = cache[WATCHER_KEY];
  if (!existing) return;
  existing.debouncer.cancelAll();
  existing.dirDebouncer.cancelAll();
  void existing.watcher.close();
  cache[WATCHER_KEY] = undefined;
}
