import path from "node:path";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { watch, type FSWatcher } from "chokidar";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath, rebuildTaskFile } from "~/server/projections/rebuilder.server";
import { getDataRoot, projectFilePath, projectsDir, taskFilePath } from "./file-store-root.server";

/**
 * Watches ${dataRoot}/projects and incrementally rebuilds projections.
 *
 * The event source is chokidar (typed add/change/unlink/unlinkDir events,
 * atomic-write coalescing, portable recursive watching); everything domain —
 * debounce, ignore rules, projection rebuilds, removal reconciliation,
 * lifecycle — stays Viberr code.
 *
 * - 250 ms trailing debounce per path (editors fire bursts of events);
 * - ignores dotfiles and `*.tmp` (our atomic-write staging files);
 * - reconciles task/project rows after directory removals;
 * - clears a failed watcher so the health route reports it accurately;
 * - started from server boot in dev AND prod;
 * - `ignoreInitial: true` pairs with the boot rescan: offline drift is
 *   reconciled before the watcher starts, so the initial scan emits nothing.
 *   (An external edit landing inside the sub-second initial scan window is
 *   picked up on its next touch or a manual rescan — route actions project
 *   synchronously and never depend on the watcher.)
 * - HMR-safe: the watcher handle lives behind a global symbol — a module
 *   reload reuses the running watcher instead of stacking a duplicate.
 */

export const WATCH_DEBOUNCE_MS = 250;

const WATCHER_KEY = Symbol.for("viberr.fileWatcher");

interface WatcherHandle {
  watcher: FSWatcher;
  fileTimers: Map<string, ReturnType<typeof setTimeout>>;
  dirTimers: Map<string, ReturnType<typeof setTimeout>>;
  root: string;
}

/**
 * Watcher lifecycle state, separate from the (nullable) handle (F10-08).
 *
 * The old transient-error self-heal scheduled a `setTimeout` re-arm and NEVER
 * stored its handle, so teardown could not cancel it — and it re-fired on the
 * exact condition teardown creates (`cache[WATCHER_KEY] === undefined`),
 * resurrecting a watcher after stop against a deleted/temp root and producing an
 * unbounded re-arm/log loop. This owns the pending re-arm timer (so teardown can
 * cancel it) and a monotonic `generation` (bumped on every intentional
 * start/stop/retire) so a fired timer can detect it is stale and abort.
 */
const WATCHER_LIFECYCLE_KEY = Symbol.for("viberr.fileWatcherLifecycle");
interface WatcherLifecycle {
  generation: number;
  reArmTimer: ReturnType<typeof setTimeout> | null;
}
function watcherLifecycle(
  cache: Record<symbol, unknown>,
): WatcherLifecycle {
  let lc = cache[WATCHER_LIFECYCLE_KEY] as WatcherLifecycle | undefined;
  if (!lc) {
    lc = { generation: 0, reArmTimer: null };
    cache[WATCHER_LIFECYCLE_KEY] = lc;
  }
  return lc;
}
function cancelPendingReArm(lc: WatcherLifecycle): void {
  if (lc.reArmTimer) {
    clearTimeout(lc.reArmTimer);
    lc.reArmTimer = null;
  }
}

/** Keep only project/task directories and their two canonical Markdown files. */
export function shouldIgnoreWatchPath(watchRoot: string, candidate: string): boolean {
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(watchRoot, candidate);
  const rel = path.relative(watchRoot, abs);
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split(path.sep);
  const base = parts.at(-1)!;
  if (parts.some((part) => part.startsWith(".")) || base.endsWith(".tmp")) return true;
  return parts.length >= 4 && !(parts.length === 4 && base === "task.md");
}

function schedule(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  key: string,
  flush: (key: string) => void,
): void {
  const current = timers.get(key);
  if (current) clearTimeout(current);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    flush(key);
  }, WATCH_DEBOUNCE_MS));
}

function cancelAll(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/** Starts (or returns the already-running) projects-tree watcher. */
export function startFileWatcher(
  options: { dataRoot?: string; db?: DatabaseSync } = {},
): FSWatcher {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  const root = getDataRoot(options.dataRoot);
  const existing = cache[WATCHER_KEY];
  if (existing && existing.root === root) return existing.watcher;
  const lc = watcherLifecycle(cache);
  if (existing) {
    // Data root changed (tests) — retire the old watcher first, and invalidate
    // any pending re-arm so it can't resurrect the retired root (F10-08).
    cancelPendingReArm(lc);
    lc.generation += 1;
    cancelAll(existing.fileTimers);
    cancelAll(existing.dirTimers);
    void existing.watcher.close();
  }

  const resolveDb = () => options.db ?? getDb();
  const watchedDir = projectsDir(options.dataRoot);
  const fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const dirTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const rebuildFile = (absPath: string) => {
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
  };

  /**
   * E13 — a directory vanished. Map it onto the projection rows it backed:
   *   projects/<slug>                → reconcile the whole project
   *   projects/<slug>/tasks          → reconcile the whole project
   *   projects/<slug>/tasks/<KEY>    → reproject that task (file gone → removed)
   * Deeper paths (a task's workspace/, attachments/…) carry no projection
   * rows — ignored. The projects ROOT itself unlinking reconciles every
   * projected project.
   */
  const rebuildDir = (absDir: string) => {
    try {
      const db = resolveDb();
      const rel = path.relative(watchedDir, absDir);
      if (rel.startsWith("..")) return;
      // A directory that is back on disk was not removed (or was already
      // recreated) — the file-level handlers project its contents.
      if (existsSync(absDir)) return;
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
        schedule(
          fileTimers,
          path.resolve(taskFilePath(slug, segments[2]!, root)),
          rebuildFile,
        );
      }
      // Deeper than the task dir: nothing projected lives there.
    } catch (error) {
      logger.error("watcher directory reconcile failed", {
        path: absDir,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  // Chokidar delivers typed events with real paths — no rename inference.
  // The ignore matcher prunes traversal too, keeping the watcher out of
  // workspace clones entirely (F-SPAWN1).
  const onFile = (eventPath: string) => {
    const absPath = path.resolve(watchedDir, eventPath);
    const base = path.basename(absPath);
    if (base === "project.md" || base === "task.md") {
      schedule(fileTimers, absPath, rebuildFile);
    }
  };

  const watcher = watch(watchedDir, {
    ignoreInitial: true,
    ignored: (candidate: string) => shouldIgnoreWatchPath(watchedDir, candidate),
    followSymlinks: false,
    atomic: true,
  });
  watcher
    .on("add", onFile)
    .on("change", onFile)
    .on("unlink", onFile)
    .on("unlinkDir", (dir: string) =>
      schedule(dirTimers, path.resolve(watchedDir, dir), rebuildDir),
    );

  watcher.on("error", (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    // A vanished path is NOT a broken watcher: deleting a watched subtree can
    // race chokidar's own bookkeeping into a spurious ENOENT while the
    // deletion's unlinkDir reconcile is still queued in the debounce. Killing
    // the watcher here cancelled that queued reconcile and orphaned the
    // projections. Log and keep watching.
    if (code === "ENOENT") {
      logger.debug("file watcher ignored ENOENT for a removed path", { code });
      return;
    }
    // E8: the handle can no longer be trusted to deliver events — clear it so
    // isFileWatcherAlive() (and /resources/health) reports the truth instead
    // of a zombie watcher.
    logger.error("file watcher error — clearing watcher handle", {
      err: error instanceof Error ? error : new Error(String(error)),
      code,
    });
    const current = cache[WATCHER_KEY];
    if (current && current.watcher === watcher) {
      cancelAll(current.fileTimers);
      cancelAll(current.dirTimers);
      cache[WATCHER_KEY] = undefined;
    }
    void watcher.close();
    // Self-heal (adversarial-review #16): transient FS-pressure errors
    // (EMFILE / ENFILE / ENOSPC / EPERM / EACCES) should not permanently kill
    // watching — re-arm after a short backoff instead of requiring a full
    // server restart. F10-08: the re-arm timer is now OWNED (cancellable by
    // teardown) and generation-guarded (a stale timer aborts) so it cannot
    // resurrect a watcher after stop or loop unboundedly on a deleted root.
    const TRANSIENT = new Set(["EMFILE", "ENFILE", "ENOSPC", "EPERM", "EACCES"]);
    if (code && TRANSIENT.has(code)) {
      const lc = watcherLifecycle(cache);
      cancelPendingReArm(lc); // at most one pending re-arm
      const scheduledGen = lc.generation;
      lc.reArmTimer = setTimeout(() => {
        lc.reArmTimer = null;
        // Stale if an intentional start/stop/retire happened since scheduling,
        // or if another watcher already took over.
        if (lc.generation !== scheduledGen) return;
        if (cache[WATCHER_KEY] !== undefined) return;
        logger.info("file watcher re-arming after a transient error", { code });
        try {
          startFileWatcher(options);
        } catch (reErr) {
          logger.error("file watcher re-arm failed", {
            err: reErr instanceof Error ? reErr : new Error(String(reErr)),
          });
        }
      }, 2_000);
      lc.reArmTimer.unref?.();
    }
  });

  // A successful (re)start supersedes any pending re-arm and is a new generation.
  cancelPendingReArm(lc);
  lc.generation += 1;
  cache[WATCHER_KEY] = { watcher, fileTimers, dirTimers, root };
  logger.info("file watcher started", { dir: watchedDir, debounceMs: WATCH_DEBOUNCE_MS });
  return watcher;
}

/** True while a store watcher is running in this process. */
export function isFileWatcherAlive(): boolean {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  return cache[WATCHER_KEY] !== undefined;
}

/**
 * Stop and forget the running watcher (process shutdown + test teardown).
 * Cancels every debounce timer and any pending re-arm, and bumps the
 * generation so a scheduled re-arm cannot resurrect the watcher (F10-08).
 * The native close is fire-and-forget: detaching timers/handlers is what
 * guarantees no rebuild callback runs after this returns.
 */
export function stopFileWatcher(): void {
  const cache = globalThis as unknown as Record<symbol, unknown>;
  const lc = watcherLifecycle(cache);
  cancelPendingReArm(lc);
  lc.generation += 1;
  const existing = cache[WATCHER_KEY] as WatcherHandle | undefined;
  if (!existing) return;
  cancelAll(existing.fileTimers);
  cancelAll(existing.dirTimers);
  void existing.watcher.close();
  cache[WATCHER_KEY] = undefined;
}
