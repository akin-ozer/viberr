import path from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { reindexKnowledgeBaseByDir } from "~/server/org/resources.server";
import { getDataRoot, kbRootDir } from "./file-store-root.server";

/**
 * Watches ${dataRoot}/kb and re-indexes a knowledge base when its store files
 * change (R-D / P11-60). Mirrors the file-native model the rest of the store
 * uses: no scheduler, no "nightly" cadence — a KB in "on change" mode simply
 * re-indexes (its `last_indexed_at` moves and its doc count is recomputed) the
 * moment a doc under it is added, edited, or removed. A KB pinned to "manual"
 * is skipped (handled inside `reindexKnowledgeBaseByDir`).
 *
 * - 250 ms trailing debounce per KB dir (editors fire event bursts);
 * - the changed path's FIRST segment under kb/ names the KB dir to re-index;
 * - HMR-safe: the handle lives behind a global symbol, so a reload reuses the
 *   running watcher instead of stacking duplicates.
 */

export const KB_WATCH_DEBOUNCE_MS = 250;

const KB_WATCHER_KEY = Symbol.for("viberr.kbWatcher");

interface KbWatcherHandle {
  watcher: FSWatcher;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  root: string;
}

/** The top-level KB dir a changed path belongs to, or null when out of tree. */
export function kbDirOfChange(kbRoot: string, changedRel: string): string | null {
  if (!changedRel) return null;
  const rel = path.relative(kbRoot, path.resolve(kbRoot, changedRel));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  if (!first || first.startsWith(".")) return null;
  return first;
}

/** Starts (or returns the already-running) kb-tree watcher. */
export function startKbWatcher(
  options: { dataRoot?: string; db?: DatabaseSync } = {},
): FSWatcher | null {
  const cache = globalThis as unknown as Record<symbol, KbWatcherHandle | undefined>;
  const root = getDataRoot(options.dataRoot);
  const kbRoot = kbRootDir(options.dataRoot);
  const existing = cache[KB_WATCHER_KEY];
  if (existing && existing.root === root) return existing.watcher;
  if (existing) {
    for (const t of existing.timers.values()) clearTimeout(t);
    existing.watcher.close();
    cache[KB_WATCHER_KEY] = undefined;
  }
  if (!existsSync(kbRoot)) return null;

  const resolveDb = () => options.db ?? getDb();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const reindex = (dir: string) => {
    try {
      const result = reindexKnowledgeBaseByDir(resolveDb(), dir, { dataRoot: root });
      if (result) {
        logger.info("kb watcher re-indexed", {
          dir,
          name: result.name,
          docCount: result.docCount,
        });
      }
    } catch (error) {
      logger.error("kb watcher re-index failed", {
        dir,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(kbRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const dir = kbDirOfChange(kbRoot, filename.toString());
      if (!dir) return;
      const pending = timers.get(dir);
      if (pending) clearTimeout(pending);
      timers.set(
        dir,
        setTimeout(() => {
          timers.delete(dir);
          reindex(dir);
        }, KB_WATCH_DEBOUNCE_MS),
      );
    });
  } catch (error) {
    logger.error("kb watcher failed to start", {
      kbRoot,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }

  watcher.on("error", (err) => {
    logger.error("kb watcher error", { err });
  });

  cache[KB_WATCHER_KEY] = { watcher, timers, root };
  logger.info("kb watcher started", { kbRoot });
  return watcher;
}

/** Stops the kb watcher (tests + teardown). */
export function stopKbWatcher(): void {
  const cache = globalThis as unknown as Record<symbol, KbWatcherHandle | undefined>;
  const existing = cache[KB_WATCHER_KEY];
  if (!existing) return;
  for (const t of existing.timers.values()) clearTimeout(t);
  existing.watcher.close();
  cache[KB_WATCHER_KEY] = undefined;
}
