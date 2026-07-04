import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { getDataRoot, projectsDir } from "./file-store-root.server";
import { createPathDebouncer, type PathDebouncer } from "./path-debounce.server";

/**
 * File watcher: chokidar (v5) on the ${dataRoot}/projects tree, driving
 * single-file incremental projection rebuilds.
 *
 * - 250 ms trailing debounce per path (editors fire bursts of events);
 * - ignores dotfiles and `*.tmp` (our atomic-write staging files);
 * - started from server boot in dev AND prod;
 * - HMR-safe: the watcher handle lives behind a global symbol — a module
 *   reload reuses the running watcher instead of stacking a duplicate.
 */

export const WATCH_DEBOUNCE_MS = 250;

const WATCHER_KEY = Symbol.for("viberr.fileWatcher");

interface WatcherHandle {
  watcher: FSWatcher;
  debouncer: PathDebouncer;
  root: string;
}

function shouldIgnore(candidate: string): boolean {
  const base = path.basename(candidate);
  return base.startsWith(".") || base.endsWith(".tmp");
}

/** Starts (or returns the already-running) projects-tree watcher. */
export function startFileWatcher(options: { dataRoot?: string } = {}): FSWatcher {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  const root = getDataRoot(options.dataRoot);
  const existing = cache[WATCHER_KEY];
  if (existing && existing.root === root) return existing.watcher;
  if (existing) {
    // Data root changed (tests) — retire the old watcher first.
    existing.debouncer.cancelAll();
    void existing.watcher.close();
  }

  const watchedDir = projectsDir(options.dataRoot);
  const debouncer = createPathDebouncer(WATCH_DEBOUNCE_MS, (absPath) => {
    try {
      const result = rebuildPath(getDb(), absPath, { dataRoot: root });
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
  watcher.on("error", (error) => {
    logger.error("file watcher error", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  });

  cache[WATCHER_KEY] = { watcher, debouncer, root };
  logger.info("file watcher started", { dir: watchedDir, debounceMs: WATCH_DEBOUNCE_MS });
  return watcher;
}

/** Stops the running watcher (tests / graceful shutdown). */
export async function stopFileWatcher(): Promise<void> {
  const cache = globalThis as unknown as Record<symbol, WatcherHandle | undefined>;
  const handle = cache[WATCHER_KEY];
  if (!handle) return;
  handle.debouncer.cancelAll();
  await handle.watcher.close();
  cache[WATCHER_KEY] = undefined;
}
